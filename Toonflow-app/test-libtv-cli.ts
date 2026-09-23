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
    # 画布列表有状态：真实 1.0.2 格式 {id:数字, uuid:32位无连字符hex, name, updatedAtMs}，create 会追加
    CANV="$STATE/canvases.json"
    if [ ! -f "$CANV" ]; then
      echo '[{"id":1,"uuid":"proj-a","name":"画布A","visibility":0,"ownerId":111,"createdAtMs":1750000000000,"updatedAtMs":1750000000000},{"id":2,"uuid":"proj-b","name":"画布B","visibility":0,"ownerId":111,"createdAtMs":1750000000000,"updatedAtMs":1750000000001}]' > "$CANV"
    fi
    if [ "$sub" = "list" ]; then
      echo "{\\"projectMetaList\\":$(cat "$CANV")}"
      exit 0
    fi
    if [ "$sub" = "create" ]; then
      U=$(tr -dc 'a-f0-9' < /dev/urandom | head -c32)
      NOW=$(date +%s)000
      node -e 'const fs=require("fs");const[f,n,u,ts]=process.argv.slice(1);const a=JSON.parse(fs.readFileSync(f,"utf-8"));a.push({id:Math.floor(Math.random()*9e8)+1e8,uuid:u,name:n,visibility:0,ownerId:111,createdAtMs:+ts,updatedAtMs:+ts});fs.writeFileSync(f,JSON.stringify(a));' "$CANV" "$3" "$U" "$NOW"
      # 真实格式：projectMetaList 包裹，uuid 无连字符（曾因只认 projectUuid 键/带连字符 uuid 而解析失败）
      if [ -f "$STATE/create-badjson" ]; then
        echo 'OPS not-json {"truncated'
      else
        echo "{\\"projectMetaList\\":[{\\"id\\":999,\\"uuid\\":\\"$U\\",\\"name\\":\\"$3\\",\\"visibility\\":0,\\"ownerId\\":111,\\"createdAtMs\\":$NOW,\\"updatedAtMs\\":$NOW}]}"
      fi
      exit 0
    fi
    if [ "$sub" = "use" ]; then
      mkdir -p .libtv
      echo "{\\"projectUuid\\":\\"$3\\"}" > .libtv/project.json
      exit 0
    fi
    # project <uuid>：回读画布节点列表（真实格式：只有 key/name/type/位置，无 URL）
    if [ -n "$sub" ]; then
      echo '{"projectUuid":"'"$sub"'","nodes":[{"id":"n-img-1","name":"角色定版","type":"image","position":{"x":0,"y":0}},{"id":"n-vid-1","name":"开场镜头","type":"video","position":{"x":1,"y":0}},{"id":"n-aud-1","name":"BGM","type":"audio","position":{"x":2,"y":0}},{"id":"n-txt-1","name":"剧本","type":"text","position":{"x":3,"y":0}}],"edges":[]}'
      exit 0
    fi
    exit 1 ;;
  model)
    # model <key>：完整 tool_spec schema（真实 1.0.2 格式，2026-09-23 校准）
    if [ "\${2:-}" != "search" ] && [ -n "\${2:-}" ]; then
      case "$2" in
        nebula-ultra) echo '{"modelKey":"nebula-ultra","schema":{"properties":{"prompt":{},"quality":{"enum":["1K","2K","4K"],"default":"2K"},"ratio":{"enum":["auto","1:1","9:16","16:9"],"default":"16:9"},"modeType":{"items":{"image2image":[0,7]}}}}}' ;;
        seedream-4) echo '{"modelKey":"seedream-4","schema":{"properties":{"prompt":{},"quality":{"enum":["2K","4K"],"default":"2K"},"ratio":{"enum":["1:1","9:16","16:9"]}}}}' ;;
        star-video2) echo '{"modelKey":"star-video2","schema":{"properties":{"modeType":{"items":{"singleImage2videos":[1,1]}},"ratio":{"enum":["adaptive","16:9","9:16"]},"resolution":{"enum":["480p","720p","1080p","4k"]},"duration":{"min":4,"max":15,"default":5},"enableSound":{"enum":["on","off"]},"lens":{}}}}' ;;
        *) echo '{"modelKey":"'"$2"'","schema":{"properties":{"prompt":{}}}}' ;;
      esac
      exit 0
    fi
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
      echo "$*" >> "$STATE/created-args.log"
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
        # 真实形态（2026-09-23 校准）：完成态无 status 字段，产物在 data.url 数组（覆盖「URL 就绪即完成」兜底）
        if [ "$n" -ge 3 ]; then
          echo '{"nodeKey":"nd-x","nodeType":"image","data":{"type":"image","name":"'"$name"'","url":["https://cdn.example.com/out.png"],"params":{"prompt":"x"}},"name":"'"$name"'"}'
        else
          echo '{"nodeKey":"nd-x","nodeType":"image","data":{"type":"image","name":"'"$name"'","url":[]},"name":"'"$name"'"}'
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

  // —— 生成参数 schema 白名单裁剪（真实校准：image 模型比例字段是 ratio 不是 aspectRatio；quality 枚举因模型而异）——
  const createdArgs = fs.readFileSync(path.join(fakeState, "created-args.log"), "utf-8");
  assert(/-s ratio=1:1/.test(createdArgs) && !createdArgs.includes("aspectRatio="), "图片比例按 schema 字段名 ratio 下发（不再传 aspectRatio）");
  assert(/-s quality=1K/.test(createdArgs), "nebula-ultra schema 允许 1K → quality=1K 下发");
  {
    const before = fs.readFileSync(path.join(fakeState, "created-args.log"), "utf-8").length;
    await api.imageRequest({ prompt: "seedream 1K 裁剪", referenceList: [], size: "1K", aspectRatio: "16:9" }, vendor.models.find((m) => m.modelName === "seedream-4") as any);
    const seedreamArgs = fs.readFileSync(path.join(fakeState, "created-args.log"), "utf-8").slice(before);
    assert(!seedreamArgs.includes("quality="), "seedream-4 枚举无 1K → quality 被裁掉（吃平台默认 2K）");
    assert(/-s ratio=16:9/.test(seedreamArgs), "seedream-4 ratio=16:9 正常下发");
  }

  // —— video 纯文本模式：modeType=text2video 不在 schema 枚举 → 自动省略，生成不因未知枚举值被拒 ——
  {
    const before = fs.readFileSync(path.join(fakeState, "created-args.log"), "utf-8").length;
    await api.videoRequest(
      { duration: 8, resolution: "1080p", aspectRatio: "9:16", prompt: "纯文本生视频", referenceList: [], audio: true, mode: ["text"] as any },
      vendor.models.find((m) => m.modelName === "star-video2") as any,
    );
    const textVidArgs = fs.readFileSync(path.join(fakeState, "created-args.log"), "utf-8").slice(before);
    assert(!textVidArgs.includes("modeType="), "text2video 不在 schema 枚举 → modeType 省略");
    assert(/-s duration=8/.test(textVidArgs) && /-s resolution=1080p/.test(textVidArgs) && /-s ratio=9:16/.test(textVidArgs) && /-s enableSound=on/.test(textVidArgs), "video 其余参数正常下发");
  }

  // 凭据落盘 + 项目绑定都发生在托管目录里
  assert(fs.existsSync(path.join(fakeWork, ".libtv", "project.json")), "画布项目绑定写在 workDir/.libtv/project.json");

  // —— 画布项目 find-or-create（真实事故回归：create 输出解析失败导致「缺少有效项目 ID」）——
  const canvasesFile = path.join(fakeState, "canvases.json");
  const readCanvases = (): any[] => JSON.parse(fs.readFileSync(canvasesFile, "utf-8"));
  const toonflowCanvases = () => readCanvases().filter((c: any) => /^toonflow$/i.test(String(c.name)));
  const boundId = (): string => {
    const parsed = JSON.parse(fs.readFileSync(path.join(fakeWork, ".libtv", "project.json"), "utf-8"));
    return String(parsed?.projectUuid ?? parsed?.projectId ?? parsed?.id ?? "");
  };
  const firstTf = toonflowCanvases()[0];
  assert(!!firstTf, "名下无 Toonflow 画布时自动创建了一个");
  assert(boundId() === firstTf.uuid, "创建后从真实格式 projectMetaList 输出解析出 uuid 并完成绑定");
  assert(/^[0-9a-f]{32}$/.test(firstTf.uuid), "真实契约：uuid 为 32 位无连字符 hex（旧解析对此失明）");

  // 新 workDir（模拟 pod 重建/换目录）→ 复用已有 Toonflow 画布，不重复建
  const work2 = path.join(tmpRoot, "work2");
  const api2 = createVendorAPI({ cliPath: fakeCli, homeDir: fakeHome, workDir: work2, projectId: "", credentialsToken: "" });
  await api2.imageRequest({ prompt: "复用画布验证", referenceList: [], size: "1K", aspectRatio: "1:1" }, vendor.models.find((m) => m.modelName === "nebula-ultra") as any);
  assert(toonflowCanvases().length === 1, "已有 Toonflow 画布时不再重复创建");
  assert(JSON.parse(fs.readFileSync(path.join(work2, ".libtv", "project.json"), "utf-8")).projectUuid === firstTf.uuid, "新 workDir 复用同一个 Toonflow 画布");

  // 绑定文件指向已被网页端删除的画布 → 自愈：重新绑到名下 Toonflow 画布
  const work3 = path.join(tmpRoot, "work3");
  fs.mkdirSync(path.join(work3, ".libtv"), { recursive: true });
  fs.writeFileSync(path.join(work3, ".libtv", "project.json"), JSON.stringify({ projectUuid: "deadbeef-deleted" }));
  const api3 = createVendorAPI({ cliPath: fakeCli, homeDir: fakeHome, workDir: work3, projectId: "", credentialsToken: "" });
  await api3.imageRequest({ prompt: "自愈验证", referenceList: [], size: "1K", aspectRatio: "1:1" }, vendor.models.find((m) => m.modelName === "nebula-ultra") as any);
  assert(JSON.parse(fs.readFileSync(path.join(work3, ".libtv", "project.json"), "utf-8")).projectUuid === firstTf.uuid, "绑定文件指向已删除画布时自愈到名下 Toonflow 画布");

  // 创建输出无法解析（格式再变）→ 画布已建成，回列表按名字找回
  {
    const kept = readCanvases().filter((c: any) => !/^toonflow$/i.test(String(c.name)));
    fs.writeFileSync(canvasesFile, JSON.stringify(kept));
    fs.writeFileSync(path.join(fakeState, "create-badjson"), "1");
    const work4 = path.join(tmpRoot, "work4");
    const api4 = createVendorAPI({ cliPath: fakeCli, homeDir: fakeHome, workDir: work4, projectId: "", credentialsToken: "" });
    let badJsonOk = false;
    try {
      await api4.imageRequest({ prompt: "坏输出恢复验证", referenceList: [], size: "1K", aspectRatio: "1:1" }, vendor.models.find((m) => m.modelName === "nebula-ultra") as any);
      badJsonOk = true;
    } catch (e) {}
    fs.rmSync(path.join(fakeState, "create-badjson"), { force: true });
    const reCreated = toonflowCanvases();
    assert(badJsonOk && reCreated.length === 1, "create 输出解析失败时回列表按名字找回画布（不抛「缺少项目 ID」）");
    assert(JSON.parse(fs.readFileSync(path.join(work4, ".libtv", "project.json"), "utf-8")).projectUuid === reCreated[0]?.uuid, "恢复路径绑定到重建后的画布");
  }

  // 显式配置画布项目 ID → 直接使用，不自动创建
  {
    const before = readCanvases().length;
    const work5 = path.join(tmpRoot, "work5");
    const api5 = createVendorAPI({ cliPath: fakeCli, homeDir: fakeHome, workDir: work5, projectId: "proj-explicit", credentialsToken: "" });
    await api5.imageRequest({ prompt: "显式ID验证", referenceList: [], size: "1K", aspectRatio: "1:1" }, vendor.models.find((m) => m.modelName === "nebula-ultra") as any);
    assert(readCanvases().length === before, "显式配置项目 ID 时不自动创建画布");
    assert(JSON.parse(fs.readFileSync(path.join(work5, ".libtv", "project.json"), "utf-8")).projectUuid === "proj-explicit", "显式配置的项目 ID 被直接绑定");
  }
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
  assert(projects.some((p) => p.id === "proj-a" && p.name === "画布A"), "project list 解析出画布项目（id/name）");
  const canvasNodes = await api.readProjectCanvas("proj-a");
  assert(canvasNodes.length === 3, `画布回读过滤掉无产物节点（4 个节点收 3 个产物，实际 ${canvasNodes.length}）`);
  const vidNode = canvasNodes.find((n) => n.key === "n-vid-1");
  assert(!!vidNode && vidNode.type === "video" && vidNode.url === "https://cdn.example.com/out2.mp4", "视频产物节点解析出类型与结果 URL");
  assert(!!vidNode && vidNode.prompt === "推镜头", "产物节点保留 prompt 元数据");
  const audNode = canvasNodes.find((n) => n.key === "n-aud-1");
  assert(!!audNode && audNode.type === "audio" && audNode.url.includes("out3.mp3"), "音频产物节点从字段名/扩展名解析出 URL");
  assert(canvasNodes.every((n) => !!n.createTime && !!n.name), "产物节点保留 createTime/name 元数据（毫秒时间戳已转 ISO）");

  // —— cliPath 兜底：配置的路径不存在时降级到默认解析（真实事故：渠道残留 /tmp 临时路径，环境清理后每次生成 ENOENT）——
  {
    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = fakeHome; // 让 ~/.libtv/libtv 不命中，逼出 PATH 兜底
    // fakeCli 本身就叫 tmpRoot/libtv 且可执行，把它放进 PATH 即可使命令名解析命中假 CLI
    process.env.PATH = `${tmpRoot}:${oldPath}`;
    try {
      const apiStale = createVendorAPI({ cliPath: "/tmp/multica-task-dead/libtv", homeDir: `${fakeHome}-stale`, workDir: path.join(tmpRoot, "work-stale"), projectId: "", credentialsToken: "" });
      const staleProjects = await apiStale.listProjects();
      assert(staleProjects.some((p) => p.id === "proj-a"), "配置的 cliPath 不存在时降级默认解析，渠道保持可用");
    } finally {
      process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  }

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
