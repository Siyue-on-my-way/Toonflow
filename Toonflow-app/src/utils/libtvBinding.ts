import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import u from "@/utils";
import getPath from "@/utils/getPath";

/**
 * LibTV 账号绑定（方案 A：短信验证码流搬进 Toonflow 页面）。
 *
 * CLI 契约（libtv 1.0.2 实测）：
 *   第一步发短信：libtv login phone -p <11位手机号>          （失败退出码非 0，stdout 为原因文本）
 *   第二步完成登录：libtv login phone -p <手机号> -c <6位验证码>
 *   登录成功后凭据写入 $HOME/.libtv/credentials.json
 *   登录态检查：libtv account info 退出码 0 = 已登录（空 project list 不算登录）
 *
 * 每个用户一个独立 HOME（<数据目录>/libtv/home/<userId>），凭据互不串号；
 * 凭据内容加密后存 o_vendorAccount（userId + 'libtv'），pod 重建不丢。
 */

const VENDOR_ID = "libtv";
const SMS_THROTTLE_MS = 60 * 1000;
const smsLastSentAt = new Map<number, number>();

/** 每用户独立 HOME，凭据与画布绑定都隔离在这里 */
export function homeDirFor(userId: number | string): string {
  return getPath(["libtv", "home", String(userId)]);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 渠道设置里的 CLI 路径（o_vendorConfig.inputValues.cliPath，非密钥字段明文存储） */
async function resolveCliPath(): Promise<string> {
  try {
    const row = await u.db("o_vendorConfig").where("id", VENDOR_ID).first();
    const configured = row?.inputValues ? JSON.parse(row.inputValues)?.cliPath : undefined;
    if (typeof configured === "string" && configured.trim()) return configured.trim();
  } catch (e) {
    // 读不到渠道配置就走默认解析
  }
  const homeDefault = path.join(os.homedir(), ".libtv", "libtv");
  if (fs.existsSync(homeDefault)) return homeDefault;
  return "libtv";
}

let cliPathCache = "";
async function getCliPath(): Promise<string> {
  if (cliPathCache) return cliPathCache;
  cliPathCache = await resolveCliPath();
  return cliPathCache;
}

async function runLibtv(homeDir: string, args: string[], timeoutMs: number): Promise<CliResult> {
  fs.mkdirSync(homeDir, { recursive: true });
  let cliPath = "";
  try {
    cliPath = await getCliPath();
  } catch (e) {
    cliPath = "libtv";
  }
  return new Promise((resolve, reject) => {
    execFile(
      cliPath,
      args,
      { cwd: homeDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && (err as any).code === "ENOENT") {
          cliPathCache = ""; // 路径失效，下次重解析
          return reject(new Error("服务器未安装 LibTV CLI，请联系管理员安装（curl -fL \"https://liblibai-web-static.liblib.cloud/cli/latest/install-libtv-cli.sh\" | bash）"));
        }
        resolve({ code: err ? Number((err as any).code) || 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** 以指定用户的隔离 HOME 执行一条 CLI 命令（导入器等用户级功能共用，凭据互不串号） */
export async function runAsUser(userId: number, args: string[], timeoutMs = 120000): Promise<CliResult> {
  return runLibtv(homeDirFor(userId), args, timeoutMs);
}

/** 第一步：给手机号发验证码。60 秒节流（进程内，尽力而为）。 */
export async function sendSms(userId: number, phone: string): Promise<{ ok: true }> {
  const trimmed = (phone ?? "").trim();
  if (!/^1\d{10}$/.test(trimmed)) throw new Error("手机号格式不正确（需要 11 位中国大陆手机号）");
  const last = smsLastSentAt.get(userId) ?? 0;
  if (Date.now() - last < SMS_THROTTLE_MS) throw new Error("发送太频繁，请 1 分钟后再试");
  const r = await runLibtv(homeDirFor(userId), ["login", "phone", "-p", trimmed], 60000);
  if (r.code !== 0) {
    const reason = (r.stdout || r.stderr || "").trim().slice(0, 200);
    if (/captcha|人机验证|验证参数/i.test(reason)) {
      throw new Error(`LibTV 要求人机验证，暂时无法自动发送短信（${reason}）。请改用「粘贴凭据」方式绑定。`);
    }
    throw new Error(`验证码发送失败：${reason || "未知错误"}`);
  }
  smsLastSentAt.set(userId, Date.now());
  return { ok: true as const };
}

/** 凭据校验（account info 退出码 0 = 有效）并写入 o_vendorAccount（加密存储） */
async function storeCredential(userId: number, phone?: string): Promise<void> {
  const home = homeDirFor(userId);
  const check = await runLibtv(home, ["account", "info"], 30000);
  if (check.code !== 0) {
    throw new Error("凭据校验失败：LibTV 返回未登录。请重新获取凭据后再试。");
  }
  const credPath = path.join(home, ".libtv", "credentials.json");
  const content = fs.readFileSync(credPath, "utf-8").trim();
  const inputValues = JSON.stringify({
    credentialsToken: u.crypto.encrypt(content),
    ...(phone ? { phone: String(phone).trim() } : {}),
    boundAt: Date.now(),
  });
  const existing = await u.db("o_vendorAccount").where({ userId, vendorId: VENDOR_ID }).first();
  if (existing) {
    await u.db("o_vendorAccount").where({ userId, vendorId: VENDOR_ID }).update({ inputValues, enable: 1 });
  } else {
    await u.db("o_vendorAccount").insert({ userId, vendorId: VENDOR_ID, enable: 1, inputValues, enabledModels: "[]" });
  }
}

/** 第二步：提交验证码完成登录，成功即保存绑定 */
export async function verifyAndSave(userId: number, phone: string, code: string): Promise<{ bound: true }> {
  const trimmedPhone = (phone ?? "").trim();
  const trimmedCode = (code ?? "").trim();
  if (!/^1\d{10}$/.test(trimmedPhone)) throw new Error("手机号格式不正确");
  if (!/^\d{6}$/.test(trimmedCode)) throw new Error("验证码格式不正确（6 位数字）");
  const r = await runLibtv(homeDirFor(userId), ["login", "phone", "-p", trimmedPhone, "-c", trimmedCode], 120000);
  if (r.code !== 0) {
    const reason = (r.stdout || r.stderr || "").trim().slice(0, 200);
    throw new Error(`登录失败：${reason || "验证码错误或已过期"}`);
  }
  await storeCredential(userId, trimmedPhone);
  return { bound: true as const };
}

/** 方案 B：粘贴 credentials.json 内容绑定（保底路径） */
export async function bindCredentials(userId: number, credentialsJson: string): Promise<{ bound: true }> {
  const content = (credentialsJson ?? "").trim();
  if (content.length < 10) throw new Error("凭据内容为空或过短");
  try {
    JSON.parse(content);
  } catch (e) {
    throw new Error("凭据不是合法的 JSON，请粘贴 credentials.json 文件的完整内容");
  }
  const home = homeDirFor(userId);
  fs.mkdirSync(path.join(home, ".libtv"), { recursive: true });
  fs.writeFileSync(path.join(home, ".libtv", "credentials.json"), content, { mode: 0o600 });
  await storeCredential(userId);
  return { bound: true as const };
}

/** 绑定状态（不回显凭据） */
export async function getBinding(userId: number): Promise<{ bound: boolean; boundAt?: number; phone?: string }> {
  const row = await u.db("o_vendorAccount").where({ userId, vendorId: VENDOR_ID }).first();
  if (!row?.inputValues) return { bound: false };
  try {
    const values = JSON.parse(row.inputValues);
    if (!values.credentialsToken) return { bound: false };
    return { bound: true, boundAt: values.boundAt, phone: values.phone };
  } catch (e) {
    return { bound: false };
  }
}

/** 解除绑定：清空该用户的凭据记录与本地凭据文件 */
export async function unbind(userId: number): Promise<{ bound: false }> {
  await u.db("o_vendorAccount").where({ userId, vendorId: VENDOR_ID }).del();
  try {
    fs.rmSync(path.join(homeDirFor(userId), ".libtv", "credentials.json"), { force: true });
  } catch (e) {}
  return { bound: false as const };
}

/** 绑定健康检查：account info 是否仍有效 */
export async function checkBindingHealth(userId: number): Promise<{ healthy: boolean }> {
  const binding = await getBinding(userId);
  if (!binding.bound) return { healthy: false };
  const r = await runLibtv(homeDirFor(userId), ["account", "info"], 30000);
  return { healthy: r.code === 0 };
}

export default { sendSms, verifyAndSave, bindCredentials, getBinding, unbind, checkBindingHealth, homeDirFor, runAsUser };
