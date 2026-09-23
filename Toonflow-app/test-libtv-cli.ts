/**
 * LibTV 渠道离线冒烟测试：用一个假 CLI 脚本模拟 libtv 的子命令输出，
 * 驱动 src/vendors/libtv.ts 的完整链路（登录检查 → 建项目绑定 → model search
 * 解析显示名 → 上传参考 → 创建节点 → 轮询 → 解析结果 URL）。
 *
 * 不需要真实 LibTV 账号；断言的是我们的参数拼装与防御式解析逻辑。
 * 用法：npx tsx test-libtv-cli.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 离线跑测试没有 MinIO/MySQL，vendor 模块链上 utils 的初始化副作用会连不上，
// 这里注册兜底 handler 忽略与被测逻辑无关的初始化报错，再动态加载 vendor。
process.on("unhandledRejection", (reason) => {
  const msg = String((reason as any)?.message ?? reason);
  if (msg.includes("ECONNREFUSED") || msg.includes("Minio") || msg.includes("S3")) {
    console.log(`（忽略离线环境初始化报错: ${msg}）`);
    return;
  }
  console.error("未处理的 Promise 拒绝:", reason);
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libtv-test-"));
const fakeHome = path.join(tmpRoot, "home");
const fakeWork = path.join(tmpRoot, "work");
const fakeState = path.join(tmpRoot, "state");
const fakeCli = path.join(tmpRoot, "libtv");
for (const d of [fakeHome, fakeWork, fakeState]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(
  fakeCli,
  `#!/usr/bin/env bash
set -u
STATE="$FAKE_STATE"
mkdir -p "$STATE"
cmd="$1"
case "$cmd" in
  account)
    exit 0 ;;
  project)
    sub="\${2:-}"
    if [ "$sub" = "create" ]; then
      echo '{"projectUuid":"proj-test-001","projectUrl":"https://www.liblib.tv/canvas?projectId=proj-test-001"}'
      exit 0
    fi
    if [ "$sub" = "use" ]; then
      mkdir -p .libtv
      echo '{"projectId":"'"$3"'"}' > .libtv/project.json
      exit 0
    fi
    if [ "$sub" = "list" ]; then
      echo '{"projectMetaList":[{"id":1,"uuid":"proj-a","name":"画布A","updatedAtMs":1750000000000,"createdAtMs":1750000000000},{"id":2,"uuid":"proj-b","name":"画布B"}]}'
      exit 0
    fi
    # project <uuid>：回读画布节点列表（真实格式：只有 key/name/type/位置，无 URL）
    if [ -n "$sub" ]; then
      echo '{"projectUuid":"'"$sub"'","nodes":[{"id":"n-img-1","name":"角色定版","type":"image","position":{"x":0,"y":0}},{"id":"n-vid-1","name":"开场镜头","type":"video","position":{"x":1,"y":0}},{"id":"n-aud-1","name":"BGM","type":"audio","position":{"x":2,"y":0}},{"id":"n-txt-1","name":"剧本","type":"text","position":{"x":3,"y":0}}],"edges":[]}'
      exit 0
    fi
    exit 1 ;;
  model)
    # model search -t <type>
    if [ "$4" = "video" ]; then
      echo '[{"modelKey":"star-video2","modelName":"StarVideo 2.0"},{"modelKey":"kling-v3-turbo","modelName":"Kling V3 Turbo"}]'
    else
      echo '{"models":[{"modelKey":"nebula-ultra","modelName":"Nebula Ultra"},{"modelKey":"seedream-4","modelName":"Seedream 4"}]}'
    fi
    exit 0 ;;
  upload)
    # upload <name> -f <file> -t <type>
    if [ ! -f "$4" ]; then echo "file not found: $4" >&2; exit 1; fi
    echo '{"newNodeKey":"up-'"$RANDOM"'","name":"'"$2"'"}'
    exit 0 ;;
  node)
    if [ "$2" = "create" ]; then
      name="$3"
      echo 0 > "$STATE/$name.cnt"
      echo "$name" >> "$STATE/created.log"
      echo '{"newNodeKey":"nd-'"$RANDOM"'","name":"'"$name"'"}'
      exit 0
    fi
    if [ "$2" = "delete" ] || [ "$2" = "remove" ]; then
      echo "$3" >> "$STATE/deleted.log"
      exit 0
    fi
    if [ "\${3:-}" = "-p" ]; then
      # 画布回读的单节点详情（真实格式：data.url 是字符串数组）
      case "$2" in
        n-img-1) echo '{"nodeKey":"n-img-1","data":{"type":"image","url":["https://cdn.example.com/out1.png"]},"nodeType":"image","name":"角色定版","data_prompt":null,"prompt":"黑衣剑客","createTime":1750000000000}' ;;
        n-vid-1) echo '{"nodeKey":"n-vid-1","data":{"type":"video","url":["https://cdn.example.com/out2.mp4"]},"nodeType":"video","name":"开场镜头","prompt":"推镜头","createTime":1750100000000}' ;;
        n-aud-1) echo '{"nodeKey":"n-aud-1","data":{"type":"audio","url":["https://cdn.example.com/out3.mp3"]},"nodeType":"audio","name":"BGM","createTime":1749900000000}' ;;
        *) echo '{"count":0}' ;;
      esac
      exit 0
    fi
    name="$2"
    n=$(cat "$STATE/$name.cnt" 2>/dev/null || echo 0)
    n=$((n+1))
    echo "$n" > "$STATE/$name.cnt"
    if [ -f "$STATE/failmode" ]; then
      echo '{"count":1,"matches":[{"name":"'"$name"'","status":"failed","errorReason":"积分不足，请充值后重试"}]}'
      exit 0
    fi
    case "$name" in
      tf-vid-*)
        if [ "$n" -ge 3 ]; then
          echo '{"count":1,"matches":[{"name":"'"$name"'","status":"success","taskInfo":{"result":{"videoUrl":"https://cdn.example.com/out.mp4"}},"left":[{"url":"https://cdn.example.com/ref-input.png"}]}]}'
        else
          echo '{"count":1,"matches":[{"name":"'"$name"'","status":"running"}]}'
        fi ;;
      *)
        if [ "$n" -ge 3 ]; then
          echo '{"count":1,"matches":[{"name":"'"$name"'","status":"success","result":{"imageUrl":"https://cdn.example.com/out.png"}}]}'
        else
          echo '{"count":1,"matches":[{"name":"'"$name"'","status":"running"}]}'
        fi ;;
    esac
    exit 0 ;;
  *)
    echo "unexpected command: $*" >&2
    exit 1 ;;
esac
`,
  { mode: 0o755 },
);

process.env.FAKE_STATE = fakeState;

let failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    failed++;
    console.error(`❌ ${msg}`);
  }
};

const main = async () => {
  const { createVendorAPI, vendor, classifyLibtvFailure, LibtvError } = await import("./src/vendors/libtv");
  // 协议目录自检
  assert(vendor.id === "libtv", "vendor.id = libtv");
  assert(vendor.models.some((m) => m.modelName === "star-video2" && m.type === "video"), "协议目录含 star-video2 视频模型");
  assert(
    vendor.inputs.some((i) => i.key === "credentialsToken" && i.type === "password"),
    "credentialsToken 输入项为 password 类型（自动加密）",
  );
  assert(vendor.inputs.some((i) => i.key === "deleteNodeAfterGen"), "协议目录含节点清理开关 deleteNodeAfterGen");

  // 错误分类（前端动作卡片的依据）
  assert(classifyLibtvFailure("积分不足，请充值") === "INSUFFICIENT_CREDITS", "积分不足 → INSUFFICIENT_CREDITS");
  assert(classifyLibtvFailure("含真人形象被审核拒绝") === "COMPLIANCE_REJECTED", "真人合规墙 → COMPLIANCE_REJECTED");
  assert(classifyLibtvFailure("unauthorized 401") === "AUTH_EXPIRED", "401 → AUTH_EXPIRED");
  assert(classifyLibtvFailure("poll timeout") === "GENERATION_TIMEOUT", "超时 → GENERATION_TIMEOUT");
  const clsErr = new LibtvError("INSUFFICIENT_CREDITS", "测试");
  assert(clsErr.message.startsWith("[LIBTV:INSUFFICIENT_CREDITS] "), "LibtvError.message 带机器可读前缀");

  const api = createVendorAPI({ cliPath: fakeCli, homeDir: fakeHome, workDir: fakeWork, projectId: "", credentialsToken: "" });

  // 环境变量注入（K8s Secret 场景）：设置页留空时应从 LIBTV_CREDENTIALS 物化凭据文件
  process.env.LIBTV_CREDENTIALS = '{"accessToken":"env-injected"}';

  const pngBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const videoUrl = await api.videoRequest(
    {
      duration: 20, // 越界值，应被裁到 15
      resolution: "8k", // 非法值，应回落 720p
      aspectRatio: "16:9",
      prompt: "主角推门进入房间，环顾四周",
      referenceList: [{ type: "image", sourceType: "base64", base64: pngBase64 } as any],
      audio: false,
      mode: [["imageReference:9"]] as any,
    },
    vendor.models.find((m) => m.modelName === "star-video2") as any,
  );
  assert(videoUrl === "https://cdn.example.com/out.mp4", `视频生成返回结果 URL（实际: ${videoUrl}）`);

  const imageUrl = await api.imageRequest(
    {
      prompt: "纯黑背景下的角色定版图，电影级光影",
      referenceList: [],
      size: "1K",
      aspectRatio: "1:1",
    },
    vendor.models.find((m) => m.modelName === "nebula-ultra") as any,
  );
  assert(imageUrl === "https://cdn.example.com/out.png", `图片生成返回结果 URL（实际: ${imageUrl}）`);

  // 凭据落盘 + 项目绑定都发生在托管目录里
  assert(fs.existsSync(path.join(fakeWork, ".libtv", "project.json")), "画布项目绑定写在 workDir/.libtv/project.json");
  const credFile = path.join(fakeHome, ".libtv", "credentials.json");
  assert(fs.existsSync(credFile) && fs.readFileSync(credFile, "utf-8") === '{"accessToken":"env-injected"}', "环境变量 LIBTV_CREDENTIALS 已物化为 credentials.json");
  const leftoverRefs: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else leftoverRefs.push(p);
    }
  };
  walk(path.join(fakeWork, "tmp"));
  assert(leftoverRefs.length === 0, `参考图临时文件已清理（残留 ${leftoverRefs.length} 个）`);

  // —— 画布回读（导入器后端链路）——
  const projects = await api.listProjects();
  assert(projects.length === 2 && projects[0].id === "proj-a" && projects[0].name === "画布A", "project list 解析出画布项目（id/name）");
  const canvasNodes = await api.readProjectCanvas("proj-a");
  assert(canvasNodes.length === 3, `画布回读过滤掉无产物节点（4 个节点收 3 个产物，实际 ${canvasNodes.length}）`);
  const vidNode = canvasNodes.find((n) => n.key === "n-vid-1");
  assert(!!vidNode && vidNode.type === "video" && vidNode.url === "https://cdn.example.com/out2.mp4", "视频产物节点解析出类型与结果 URL");
  assert(!!vidNode && vidNode.prompt === "推镜头", "产物节点保留 prompt 元数据");
  const audNode = canvasNodes.find((n) => n.key === "n-aud-1");
  assert(!!audNode && audNode.type === "audio" && audNode.url.includes("out3.mp3"), "音频产物节点从字段名/扩展名解析出 URL");
  assert(canvasNodes.every((n) => !!n.createTime && !!n.name), "产物节点保留 createTime/name 元数据（毫秒时间戳已转 ISO）");

  // —— 节点删除（清理开关的底层能力）——
  assert((await api.deleteNode("n-old-1")) === true, "node delete 成功返回 true");
  assert(fs.existsSync(path.join(fakeState, "deleted.log")), "node delete 调用了 CLI");

  // —— 生成失败分类 e2e：failmode 下节点返回「积分不足」→ 错误带 [LIBTV:INSUFFICIENT_CREDITS] 前缀 ——
  fs.writeFileSync(path.join(fakeState, "failmode"), "1");
  let failCode = "";
  try {
    await api.imageRequest({ prompt: "会失败的图", referenceList: [], size: "1K", aspectRatio: "1:1" }, vendor.models.find((m) => m.modelName === "nebula-ultra") as any);
  } catch (e: any) {
    failCode = String(e.message ?? "");
  }
  fs.rmSync(path.join(fakeState, "failmode"), { force: true });
  assert(failCode.startsWith("[LIBTV:INSUFFICIENT_CREDITS]"), `失败错误带分类前缀（实际: ${failCode.slice(0, 60)}）`);

  // —— 节点清理开关：延迟队列，下一轮生成时清理上一轮的临时节点 ——
  const cleanupWork = path.join(tmpRoot, "work-cleanup");
  fs.mkdirSync(cleanupWork, { recursive: true });
  const cleanupApi = createVendorAPI({ cliPath: fakeCli, homeDir: fakeHome, workDir: cleanupWork, projectId: "", credentialsToken: "", deleteNodeAfterGen: "1" });
  await cleanupApi.imageRequest({ prompt: "清理开关-第一轮", referenceList: [], size: "1K", aspectRatio: "1:1" }, vendor.models.find((m) => m.modelName === "nebula-ultra") as any);
  const queueFile = path.join(cleanupWork, "pending-node-cleanup.json");
  const pendingAfterFirst: string[] = JSON.parse(fs.readFileSync(queueFile, "utf-8"));
  assert(pendingAfterFirst.length === 1, `第一轮生成后临时节点进入待清理队列（实际 ${pendingAfterFirst.length}）`);
  assert(!fs.existsSync(path.join(fakeState, "deleted.log")) || !fs.readFileSync(path.join(fakeState, "deleted.log"), "utf-8").includes(pendingAfterFirst[0] ?? "~"), "第一轮生成时立即删除（应延迟）");
  await cleanupApi.imageRequest({ prompt: "清理开关-第二轮", referenceList: [], size: "1K", aspectRatio: "1:1" }, vendor.models.find((m) => m.modelName === "nebula-ultra") as any);
  const deletedLog = fs.readFileSync(path.join(fakeState, "deleted.log"), "utf-8");
  assert(deletedLog.includes(pendingAfterFirst[0]), "第二轮生成时清理了上一轮的临时节点");
  assert(JSON.parse(fs.readFileSync(queueFile, "utf-8")).length === 1, "队列清空后重新登记本轮节点");

  if (failed > 0) {
    console.error(`\n${failed} 项断言失败`);
    process.exit(1);
  }
  console.log("\n全部断言通过");
  // utils 初始化链上的 knex/oss 连接不会主动释放，主动退出避免进程悬挂
  process.exit(0);
};

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
