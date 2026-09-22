/**
 * LibTV 账号绑定流程冒烟测试（方案 A 短信流 + 方案 B 粘贴流）。
 * 用假 CLI 模拟 `libtv login phone` 两步契约与 `account info`，离线验证：
 * 发送节流/失败分类 → 验证码错误 → 验证码正确落库（加密）→ 绑定状态 → 方案 B 粘贴 → 解绑。
 * 用法：npx tsx test-libtv-binding.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// 本地假结果源：urlToBase64 会真的去拉结果 URL，离线环境用本机 http 服务顶上。
// 端口在 main() 里监听后通过环境变量 FAKE_PORT 传给假 CLI（脚本在执行时读取）。
const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "image/png" });
  res.end("fake-png-bytes");
});

process.on("unhandledRejection", (reason) => {
  const msg = String((reason as any)?.message ?? reason);
  if (msg.includes("ECONNREFUSED") || msg.includes("Minio") || msg.includes("S3")) {
    console.log(`（忽略离线环境初始化报错: ${msg}）`);
    return;
  }
  console.error("未处理的 Promise 拒绝:", reason);
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libtv-bind-"));
const fakeCli = path.join(tmpRoot, "libtv");
fs.mkdirSync(tmpRoot, { recursive: true });

// 假 CLI：严格模拟 libtv 1.0.2 契约
//  ① login phone -p <phone>            无效号 → exit1 "发送失败: 手机号格式不正确"；有效号 → 发送成功
//  ② login phone -p <phone> -c <code>  code=123456 → 写 $HOME/.libtv/credentials.json 并成功；否则 exit1
//  ③ account info                      永远成功
//  ④ model search / project / upload / node —— 供走真实 Ai.Image 调用链（用户级凭据合并 → vendor → CLI）
fs.writeFileSync(
  fakeCli,
  `#!/usr/bin/env bash
set -u
cmd="$1"; sub="\${2:-}"
if [ "$cmd" = "account" ] && [ "$sub" = "info" ]; then exit 0; fi
if [ "$cmd" = "login" ] && [ "$sub" = "phone" ]; then
  phone=""; code=""
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      -p) phone="$2"; shift 2 ;;
      -c) code="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -z "$code" ]; then
    case "$phone" in
      1[3-9]?????????) echo "验证码已发送" ; exit 0 ;;
      *) echo "发送失败: 手机号格式不正确" >&2; exit 1 ;;
    esac
  fi
  if [ "$code" = "123456" ]; then
    mkdir -p "$HOME/.libtv"
    echo '{"accessToken":"fake-token-for-'"$phone"'"}' > "$HOME/.libtv/credentials.json"
    echo "登录成功"
    exit 0
  fi
  echo "验证码错误或已过期" >&2
  exit 1
fi
if [ "$cmd" = "model" ] && [ "$sub" = "search" ]; then
  echo '{"models":[{"modelKey":"nebula-ultra","modelName":"Nebula Ultra"}]}'
  exit 0
fi
if [ "$cmd" = "project" ]; then
  if [ "$sub" = "create" ]; then echo '{"projectUuid":"proj-bind-001"}'; exit 0; fi
  if [ "$sub" = "use" ]; then mkdir -p .libtv; echo '{"projectId":"'"$3"'"}' > .libtv/project.json; exit 0; fi
  exit 1
fi
if [ "$cmd" = "upload" ]; then
  if [ ! -f "$4" ]; then echo "file not found" >&2; exit 1; fi
  echo '{"newNodeKey":"up-1"}'
  exit 0
fi
if [ "$cmd" = "node" ]; then
  if [ "$sub" = "create" ]; then echo 0 > "$FAKE_STATE/$3.cnt" 2>/dev/null || true; echo '{"newNodeKey":"nd-1"}'; exit 0; fi
  name="$2"
  n=$(cat "$FAKE_STATE/$name.cnt" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$FAKE_STATE/$name.cnt"
  if [ "$n" -ge 2 ]; then
    echo '{"count":1,"matches":[{"name":"'"$name"'","status":"success","result":{"imageUrl":"http://127.0.0.1:'"$FAKE_PORT"'/bind-out.png"}}]}'
  else
    echo '{"count":1,"matches":[{"name":"'"$name"'","status":"running"}]}'
  fi
  exit 0
fi
echo "unexpected: $*" >&2
exit 1
`,
  { mode: 0o755 },
);
process.env.FAKE_STATE = path.join(tmpRoot, "state");
fs.mkdirSync(process.env.FAKE_STATE, { recursive: true });

let failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`✅ ${msg}`);
  else {
    failed++;
    console.error(`❌ ${msg}`);
  }
};

const throws = async (fn: () => Promise<any>, keyword: string, msg: string) => {
  try {
    await fn();
    assert(false, `${msg}（未抛错）`);
  } catch (e: any) {
    assert(String(e?.message ?? "").includes(keyword), `${msg}（实际: ${String(e?.message).slice(0, 60)}）`);
  }
};

const main = async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  process.env.FAKE_PORT = String((httpServer.address() as any).port);

  const { default: libtvBinding } = await import("@/utils/libtvBinding");
  const u = (await import("@/utils")).default;

  // 把渠道配置里的 cliPath 指到假 CLI（initDB 已建表；渠道行不存在则补）
  const row = await u.db("o_vendorConfig").where("id", "libtv").first();
  const inputValues = JSON.stringify({ cliPath: fakeCli });
  if (row) await u.db("o_vendorConfig").where("id", "libtv").update({ inputValues });
  else await u.db("o_vendorConfig").insert({ id: "libtv", enable: 0, inputValues, models: "[]", enabledModels: "[]" });

  const FAKE_CRED = '{"accessToken":"pasted-token"}';

  // —— 方案 A：短信流 ——
  await throws(() => libtvBinding.sendSms(101, "11111111111"), "手机号格式不正确", "无效手机号被本地校验拦截");
  await throws(() => libtvBinding.sendSms(101, "12345678901"), "发送失败: 手机号格式不正确", "非法前缀手机号被 CLI 拒绝并透传原因");
  assert((await libtvBinding.sendSms(101, "13800138000")).ok === true, "有效手机号发送验证码成功");
  await throws(() => libtvBinding.sendSms(101, "13800138000"), "发送太频繁", "60 秒节流生效");
  await throws(() => libtvBinding.verifyAndSave(101, "13800138000", "000000"), "登录失败", "错误验证码被拒绝");
  assert((await libtvBinding.verifyAndSave(101, "13800138000", "123456")).bound === true, "正确验证码完成登录");
  assert(fs.existsSync(path.join(libtvBinding.homeDirFor(101), ".libtv", "credentials.json")), "凭据已物化到用户 HOME");

  const binding = await libtvBinding.getBinding(101);
  assert(binding.bound === true && binding.phone === "13800138000", "绑定状态可查询（含手机号）");
  const stored = JSON.parse((await u.db("o_vendorAccount").where({ userId: 101, vendorId: "libtv" }).first())!.inputValues!);
  assert(u.crypto.decrypt(stored.credentialsToken) === '{"accessToken":"fake-token-for-13800138000"}', "凭据加密落库且可解密还原");

  // —— 方案 B：粘贴凭据 ——
  await throws(() => libtvBinding.bindCredentials(102, "this is not valid json at all"), "不是合法的 JSON", "非法凭据被拦截");
  assert((await libtvBinding.bindCredentials(102, FAKE_CRED)).bound === true, "粘贴凭据绑定成功");
  const storedB = JSON.parse((await u.db("o_vendorAccount").where({ userId: 102, vendorId: "libtv" }).first())!.inputValues!);
  assert(u.crypto.decrypt(storedB.credentialsToken) === FAKE_CRED, "方案 B 凭据加密落库");
  assert((await libtvBinding.checkBindingHealth(102)).healthy === true, "绑定健康检查通过（account info 成功）");

  // —— 状态互查与解绑 ——
  assert((await libtvBinding.getBinding(103)).bound === false, "未绑定用户状态为 false");
  await libtvBinding.unbind(102);
  assert((await libtvBinding.getBinding(102)).bound === false, "解绑后状态为 false");
  assert(!fs.existsSync(path.join(libtvBinding.homeDirFor(102), ".libtv", "credentials.json")), "解绑后本地凭据文件被清除");

  // —— 调用链：用户级凭据覆盖 + per-user HOME ——（走真实 Ai.Image → getVendorTemplateFn → vendor → 假 CLI）
  await u.vendor.setEnabledModelNames("libtv", ["nebula-ultra"]);
  const aiImage = await u.Ai.Image("libtv:nebula-ultra", 101).run({
    prompt: "绑定链路测试图",
    referenceList: [],
    size: "1K",
    aspectRatio: "1:1",
  });
  // 平台约定：ai.ts 的 urlToBase64 返回不带 data: 前缀的裸 base64（所有渠道一致）
  assert(
    String((aiImage as any).result) === Buffer.from("fake-png-bytes").toString("base64"),
    "已绑定用户走真实调用链拿到生成结果（用户级凭据 + per-user HOME + 结果下载转存生效）",
  );
  const userWorkBind = path.resolve(process.cwd(), "data", "libtv", "work", "101", ".libtv", "project.json");
  assert(fs.existsSync(userWorkBind), "生成链路把画布项目绑定写在该用户自己的 work 目录下");

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
