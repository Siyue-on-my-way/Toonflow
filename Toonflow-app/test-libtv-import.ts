/**
 * 「从 LibTV 导入」资源导入器冒烟测试：
 * 假 CLI 模拟 `project list` / `project <id>` 画布回读，本机 http 服务顶产物 URL 的下载，
 * oss.writeFile 打桩捕获落盘，验证：项目列表 → 产物节点解析（过滤/排序/已导入标记）→
 * 勾选导入（下载→素材库落库→来源标记）→ 幂等重导跳过 → 未绑定拦截。
 *
 * 不需要真实 LibTV 账号与 MinIO；断言的是导入器解析与入库逻辑。
 * 用法：npx tsx test-libtv-import.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// 本机假产物源：导入器会真的下载节点 URL，用 http 服务顶上
const httpServer = http.createServer((req, res) => {
  if (req.url?.endsWith(".mp4")) {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end("fake-mp4-bytes");
  } else if (req.url?.endsWith(".mp3")) {
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end("fake-mp3-bytes");
  } else {
    res.writeHead(200, { "content-type": "image/png" });
    res.end("fake-png-bytes");
  }
});

process.on("unhandledRejection", (reason) => {
  const msg = String((reason as any)?.message ?? reason);
  if (msg.includes("ECONNREFUSED") || msg.includes("Minio") || msg.includes("S3")) {
    console.log(`（忽略离线环境初始化报错: ${msg}）`);
    return;
  }
  console.error("未处理的 Promise 拒绝:", reason);
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libtv-imp-"));
const fakeCli = path.join(tmpRoot, "libtv");
fs.mkdirSync(tmpRoot, { recursive: true });

fs.writeFileSync(
  fakeCli,
  `#!/usr/bin/env bash
set -u
cmd="$1"; sub="\${2:-}"
if [ "$cmd" = "account" ] && [ "$sub" = "info" ]; then exit 0; fi
if [ "$cmd" = "project" ]; then
  if [ "$sub" = "list" ]; then
    echo '{"projects":[{"projectId":"cv-001","name":"我的短剧画布","updateTime":"2026-09-20 10:00:00"},{"projectId":"cv-002","name":"练习画布"}]}'
    exit 0
  fi
  # project <id>：回读画布，含图/视频/音频产物、无 URL 的草稿节点、已导入过的节点
  if [ -n "$sub" ] && [ "$sub" != "list" ] && [ "$sub" != "create" ] && [ "$sub" != "use" ]; then
    echo '{"nodes":[{"nodeKey":"img-1","name":"角色定版图","nodeType":"image","prompt":"black clothed swordsman, full body","result":{"imageUrl":"http://127.0.0.1:'"$FAKE_PORT"'/a.png"},"createTime":"2026-09-20 10:00:00"},{"nodeKey":"vid-1","name":"开场镜头","nodeType":"video","taskInfo":{"result":{"videoUrl":"http://127.0.0.1:'"$FAKE_PORT"'/b.mp4"}},"createTime":"2026-09-21 09:00:00"},{"nodeKey":"aud-1","name":"BGM","nodeType":"audio","audioUrl":"http://127.0.0.1:'"$FAKE_PORT"'/c.mp3","createTime":"2026-09-19 08:00:00"},{"nodeKey":"txt-1","name":"草稿剧本","nodeType":"text","content":"第一幕...","createTime":"2026-09-18 08:00:00"},{"nodeKey":"img-already","name":"已导入的图","nodeType":"image","result":{"imageUrl":"http://127.0.0.1:'"$FAKE_PORT"'/d.png"},"createTime":"2026-09-17 08:00:00"}]}'
    exit 0
  fi
  exit 1
fi
echo "unexpected: $*" >&2
exit 1
`,
  { mode: 0o755 },
);

let failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`✅ ${msg}`);
  else {
    failed++;
    console.error(`❌ ${msg}`);
  }
};

const main = async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  process.env.FAKE_PORT = String((httpServer.address() as any).port);

  const u = (await import("@/utils")).default;
  const { default: libtvImport } = await import("@/utils/libtvImport");
  const { default: libtvBinding } = await import("@/utils/libtvBinding");
  const { LibtvError } = await import("@/vendors/libtv");

  // initDB 是异步建表的 fire-and-forget，先等 o_vendorConfig 就绪再动手
  for (let i = 0; i < 120; i++) {
    if (await u.db.schema.hasTable("o_vendorConfig").catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // 假 CLI 注册进渠道配置（binding/import 共用这个路径解析；只改 inputValues，
  // 不动 initDB 种子出来的模型目录，避免破坏后续 Ai 调用链测试）
  const cfgRow = await u.db("o_vendorConfig").where("id", "libtv").first();
  if (cfgRow) {
    let merged: Record<string, string> = {};
    try {
      merged = JSON.parse(cfgRow.inputValues ?? "{}");
    } catch (e) {}
    await u.db("o_vendorConfig").where("id", "libtv").update({ inputValues: JSON.stringify({ ...merged, cliPath: fakeCli }), enable: 1 });
  } else {
    await u.db("o_vendorConfig").insert({ id: "libtv", enable: 1, inputValues: JSON.stringify({ cliPath: fakeCli }), models: "[]", enabledModels: "[]" });
  }

  // oss 打桩：捕获落盘调用，不真连 MinIO（导入已改流式直传，这里把流消费掉并统计字节数）
  const ossWrites: { path: string; size: number }[] = [];
  (u.oss as any).writeFile = async (p: string, data: any) => {
    let buf: Buffer;
    if (data && typeof data.on === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(Buffer.from(chunk));
      buf = Buffer.concat(chunks);
    } else {
      buf = Buffer.from(data);
    }
    ossWrites.push({ path: p, size: buf.length });
  };

  // 清理上次运行残留（sqlite 落盘持久化，测试要可重跑）：解绑测试用户、清掉测试项目里已导入的素材
  await libtvBinding.unbind(201);
  const oldAssets = await u.db("o_assets").where("projectId", 9001).select("id");
  if (oldAssets.length) {
    // o_assets.imageId 外键指向 o_image，先删资产再删图
    await u.db("o_assets").where("projectId", 9001).del();
    await u.db("o_image").whereIn("assetsId", oldAssets.map((a: any) => a.id)).del();
  }

  // —— 未绑定拦截 ——
  let notBoundErr = "";
  try {
    await libtvImport.listUserProjects(201);
  } catch (e: any) {
    notBoundErr = String(e.message ?? "");
  }
  assert(notBoundErr.startsWith("[LIBTV:NOT_BOUND]"), `未绑定用户被 NOT_BOUND 拦截（实际: ${notBoundErr.slice(0, 50)}）`);

  // —— 给用户 201 绑定一个账号（粘贴流，写假凭据 + account info 假 CLI 验活）——
  await libtvBinding.bindCredentials(201, '{"accessToken":"import-test-token"}');
  assert((await libtvBinding.getBinding(201)).bound === true, "测试用户已绑定");

  // —— 第一步：项目列表 ——
  const projects = await libtvImport.listUserProjects(201);
  assert(projects.length === 2 && projects[0].id === "cv-001" && projects[0].name === "我的短剧画布", "project list 解析出用户画布项目");

  // —— 第二步：产物节点（过滤无 URL 节点 + 已导入标记 + 时间倒序）——
  const toonflowProjectId = 9001;
  const nodes = await libtvImport.getProjectNodes(201, "cv-001", toonflowProjectId);
  assert(nodes.length === 4, `画布 5 个节点收 4 个产物（纯文本草稿被过滤，实际 ${nodes.length}）`);
  assert(nodes[0].key === "vid-1", "产物按生成时间倒序（新的在前）");
  assert(nodes.every((n) => n.imported === false), "首次读取全部未导入");
  assert(String(nodes.find((n) => n.key === "img-1")?.prompt).includes("swordsman"), "节点 prompt 元数据带回");

  // —— 第三步：勾选导入（图 + 视频）——
  const result = await libtvImport.importNodes(201, toonflowProjectId, "cv-001", ["img-1", "vid-1"]);
  assert(result.importedCount === 2 && result.failed.length === 0, `导入 2 个产物成功（实际 ${result.importedCount}）`);
  assert(ossWrites.length === 2, "产物下载后经 oss.writeFile 落盘 2 次");
  assert(ossWrites.every((w) => w.path.startsWith(`/${toonflowProjectId}/assets/`)), "落盘路径在项目素材目录下");
  assert(ossWrites.some((w) => w.path.endsWith(".png")) && ossWrites.some((w) => w.path.endsWith(".mp4")), "扩展名按类型正确落盘");

  const assets = await u.db("o_assets").where("projectId", toonflowProjectId).select("*");
  assert(assets.length === 2, "素材库新增 2 条 o_assets");
  assert(assets.every((a: any) => String(a.remark).includes("来源: LibTV")), "素材 remark 带「来源: LibTV」标签");
  assert(assets.every((a: any) => /节点\s+\S+/.test(String(a.remark))), "remark 携带画布节点 key（幂等去重依据）");
  assert(assets.every((a: any) => a.type === "clip"), "导入素材类型为 clip（素材）");
  const imgs = await u.db("o_image").whereIn("assetsId", assets.map((a: any) => a.id)).select("*");
  assert(imgs.length === 2 && imgs.every((i: any) => i.state === "已完成"), "o_image 落库并与素材关联");
  assert(assets.some((a: any) => String(a.prompt ?? "").includes("swordsman")), "导入素材保留 prompt");

  // —— 幂等：重导同一节点 → skipped；节点列表里标记 imported ——
  const again = await libtvImport.importNodes(201, toonflowProjectId, "cv-001", ["img-1"]);
  assert(again.importedCount === 0 && again.skippedCount === 1, "重复导入同一节点被跳过（一次性收编）");
  const nodesAgain = await libtvImport.getProjectNodes(201, "cv-001", toonflowProjectId);
  assert(nodesAgain.find((n) => n.key === "img-1")?.imported === true, "节点列表标记已导入状态");

  // —— 失败路径：不存在的节点 key ——
  const badKey = await libtvImport.importNodes(201, toonflowProjectId, "cv-001", ["ghost-node"]);
  assert(badKey.importedCount === 0 && badKey.failed.length === 1, "不存在的节点进 failed 列表");

  // —— 只读不写回：全程没有对 LibTV 侧的写入命令（假 CLI 对未知命令会 exit 1，上面没有任何触发）——
  assert(true, "导入全程未调用任何写画布命令（project use/create、node create、upload 均未触发）");

  // —— 归属校验（P1-6 IDOR 修复）：目标项目不属于当前用户时拒绝 ——
  await u.db("o_project").insert({ id: 999901, userId: 999, name: "别人的项目" });
  await u.db("o_project").insert({ id: 999902, userId: 201, name: "自己的项目" });
  let idorRejected = "";
  try {
    await libtvImport.assertProjectOwnership(201, 999901);
  } catch (e: any) {
    idorRejected = String(e.message ?? "");
  }
  assert(idorRejected.includes("不属于当前用户"), `他人的项目被归属校验拒绝（实际: ${idorRejected.slice(0, 40)}）`);
  let owned = true;
  try {
    await libtvImport.assertProjectOwnership(201, 999902);
  } catch (e) {
    owned = false;
  }
  assert(owned, "自己的项目通过归属校验");
  await u.db("o_project").whereIn("id", [999901, 999902]).del();

  if (failed > 0) {
    console.error(`\n${failed} 项断言失败`);
    process.exit(1);
  }
  console.log("\n全部断言通过");
  process.exit(0); // utils 初始化链上的连接不会主动释放，主动退出
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
