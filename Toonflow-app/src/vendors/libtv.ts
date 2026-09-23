import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VendorConfig, TextModel, ImageModel, VideoModel, TTSModel, ImageConfig, VideoConfig, TTSConfig, PollResult, ReferenceList, VideoMode } from "@/types/vendor";
import { pollTask, logger } from "@/utils/vm";
import getPath from "@/utils/getPath";

/**
 * Toonflow AI供应商 - LibTV（liblib.tv 画布 CLI 渠道）
 *
 * 通过 LibTV 官方 CLI（~/.libtv/libtv）在用户的 LibTV 画布上创建节点、上传参考、
 * 触发生成并轮询结果。区别于其它 HTTP API 渠道：没有 token 级 OpenAPI（旧的
 * sk-libtv-* access key 已废弃），一切操作都通过 CLI 子进程完成，凭据来自
 * `libtv login web` 产出的 credentials.json。
 *
 * 调研依据：PomeloR611/libtv-video-agent 的 CLI 1.0.2 审计（2026-08-05）、
 * libtv-labs/libtv-skills、docs/libtv-cli-integration.md（本仓库）。
 *
 * ⚠️ CLI 的 node/model 输出格式官方未公开 schema，本文件的状态解析是防御式的
 * （见 parseNodeOutput / extractResultUrl），首次真实生成后建议按实际输出校准。
 *
 * @version 1.0
 */

// ============================================================
// 供应商配置（Layer1：协议目录的一部分，全账号共享只读）
// ============================================================

export const vendor: VendorConfig = {
  id: "libtv",
  version: "1.0",
  author: "Toonflow",
  name: "LibTV（画布CLI）",
  description:
    "LibTV（liblib.tv）AI 创作画布渠道，通过官方 CLI 调用其聚合的生图/生视频模型（StarVideo 2.0、Nebula、Seedream 等）。\n\n" +
    "使用前提：\n" +
    "1. 服务器安装 CLI：`curl -fL \"https://liblibai-web-static.liblib.cloud/cli/latest/install-libtv-cli.sh\" | bash`（装到 ~/.libtv/libtv）。\n" +
    "2. 登录授权：CLI 只支持浏览器/手机验证码登录。在任意一台有浏览器的机器执行 `libtv login web`，登录成功后把 `~/.libtv/credentials.json` 的完整内容粘贴到「登录凭据」输入框；或服务器本机登录后把「CLI HOME 目录」指向对应 home；K8s 部署也可用环境变量 LIBTV_CREDENTIALS 注入（Secret 挂载），优先级：设置页 > 环境变量。\n" +
    "3. 「画布项目 ID」留空时生成会自动绑定名下名为 Toonflow 的画布项目（找不到同名画布才自动创建），生成产物都落在这一个专用画布里；也可以在网页端画布 URL 的 projectId 参数里复制一个填进来。\n\n" +
    "注意：生成会消耗 LibTV 账号积分；含真人形象的参考图会被平台合规墙拦截。",
  inputs: [
    { key: "cliPath", label: "CLI 可执行文件路径", type: "text", required: false, placeholder: "默认：~/.libtv/libtv" },
    { key: "credentialsToken", label: "登录凭据（credentials.json 内容）", type: "password", required: false, placeholder: "本机 libtv login web 后，~/.libtv/credentials.json 的完整 JSON 内容；也可用环境变量 LIBTV_CREDENTIALS 注入" },
    { key: "homeDir", label: "CLI HOME 目录", type: "text", required: false, placeholder: "默认：<数据目录>/libtv/home，用于存放 credentials.json" },
    { key: "workDir", label: "画布绑定目录", type: "text", required: false, placeholder: "默认：<数据目录>/libtv/work，用于存放项目绑定 project.json" },
    { key: "projectId", label: "LibTV 画布项目 ID", type: "text", required: false, placeholder: "留空则自动绑定名下名为 Toonflow 的画布项目（无则自动创建）" },
    { key: "deleteNodeAfterGen", label: "生成后清理临时节点", type: "text", required: false, placeholder: "填 1 开启：生成成功后下次生成时自动删除临时节点，画布不膨胀（默认保留全部节点）" },
  ],
  inputValues: {
    cliPath: "",
    credentialsToken: "",
    homeDir: "",
    workDir: "",
    projectId: "",
    deleteNodeAfterGen: "",
  },
  models: [
    // modelName 用 LibTV 的 schema 查询键（modelKey）作为本渠道的稳定标识，
    // 真正创建节点时的 -s model= 显示名在运行时通过 `libtv model search` 解析
    // （LibTV 会改显示名，如 Seedance 2.0 VIP → StarVideo 2.0，schema 键更稳定）。
    {
      name: "StarVideo 2.0（LibTV）",
      modelName: "star-video2",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:9"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      name: "Nebula Ultra（LibTV 生图）",
      modelName: "nebula-ultra",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
    {
      name: "Seedream 4（LibTV 生图）",
      modelName: "seedream-4",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
  ],
};

// schema 键 → 已核实的创建用显示名兜底（CLI 1.0.2 审计，2026-08-05）。
// 显示名会变，运行时优先用 `libtv model search` 的实时结果，查不到才落到这里。
const KNOWN_MODEL_NAMES: Record<string, string> = {
  // 2026-09-23 真实目录校准（显示名会随平台改版漂移，运行时优先用 model search 实时解析）
  "star-video2": "Seedance 2.0 VIP",
  "nebula-ultra": "General image Pro",
  "seedream-4": "Seedream 4.0",
};

// ============================================================
// 错误分类（前端据此把失败映射成带动作的卡片：重新绑定/充值/换参考图/换模型）
// ============================================================

export type LibtvErrorCode =
  | "NOT_BOUND" // 用户还没绑定 LibTV 账号（去绑定）
  | "AUTH_EXPIRED" // 凭据失效/未登录（重新绑定）
  | "INSUFFICIENT_CREDITS" // 积分/余额不足（去充值）
  | "COMPLIANCE_REJECTED" // 真人合规墙/内容审核拒绝（换参考图/换模型）
  | "GENERATION_TIMEOUT" // 生成超时（转后台，任务中心查看）
  | "UNKNOWN";

/** 带分类码的 LibTV 错误：message = `[LIBTV:<CODE>] 可读原因`，errorReason 落库后前端按前缀渲染动作卡片 */
export class LibtvError extends Error {
  code: LibtvErrorCode;
  constructor(code: LibtvErrorCode, message: string) {
    super(`[LIBTV:${code}] ${message}`);
    this.code = code;
    this.name = "LibtvError";
  }
}

/** 按失败原因文本分类（CLI 输出格式未公开，按关键词启发式，miss 归 UNKNOWN） */
export function classifyLibtvFailure(reason: string): LibtvErrorCode {
  const text = String(reason ?? "");
  if (/(积分|余额|点数|credit|balance|insufficient|quota)/i.test(text)) return "INSUFFICIENT_CREDITS";
  if (/(合规|审核|敏感|真人|censored|moderat|policy|content.?filter|violate)/i.test(text)) return "COMPLIANCE_REJECTED";
  if (/(未登录|凭据失效|401|unauthorized|login|token.?expire)/i.test(text)) return "AUTH_EXPIRED";
  if (/(超时|timeout)/i.test(text)) return "GENERATION_TIMEOUT";
  return "UNKNOWN";
}

/** 宽松解析 CLI 输出里的 JSON：整体 JSON → 逐行 NDJSON → null（输出格式未公开，防御式） */
export function parseCliJson(stdout: string): any {
  const trimmed = String(stdout ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {}
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    try {
      return JSON.parse(t);
    } catch (e) {}
  }
  return null;
}

/** 画布项目（导入器第一步：project list 的条目） */
export interface LibtvProjectInfo {
  id: string;
  name: string;
  updateTime?: string;
}

/** 画布产物节点（导入器第二步：project <id> 回读后筛出的图/视频/音频产物） */
export interface LibtvCanvasNode {
  key: string;
  name: string;
  type: "image" | "video" | "audio" | "other";
  prompt: string;
  url: string;
  createTime?: string;
}

// StarVideo 2.0 当前 schema 允许值（2026-08-05 审计），越界值直接裁掉避免 schema 校验被拒
const VIDEO_RATIOS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"];
const VIDEO_DURATION_MIN = 4;
const VIDEO_DURATION_MAX = 15;

// ===== 模块级跨实例共享状态（每任务都会新建 createVendorAPI 实例，闭包内缓存等于没有缓存）=====
// 登录态：按 HOME 目录分键（用户级绑定 = 每用户独立 HOME）
const loginOkUntilByKey = new Map<string, number>();
// 画布绑定去重：按 workDir+目标项目分键。并发首次生成时各任务共享同一份 in-flight 绑定 Promise，
// 否则 N 个并发 ensureProject 会各自 project create 出 N 个重复画布（且 bindFile last-writer-wins 会让先建节点的任务查不到节点）
const projectBindingsByKey = new Map<string, Promise<string>>();
// 模型显示名缓存：LibTV 目录是平台级的（非账号私有），可跨用户/实例共享
const sharedModelNameCache = new Map<string, { value: string; until: number }>();
// 模型 schema 缓存（同样是平台级）：生成参数按 schema 白名单裁剪，防「未知字段」校验拒单
const sharedModelSchemaCache = new Map<string, { value: LibtvModelSchema | null; until: number }>();

/** `libtv model <key>` 里我们关心的部分：顶层允许的参数字段 + 字符串枚举字段的允许值 */
interface LibtvModelSchema {
  props: Set<string>;
  enums: Record<string, string[]>;
}

export function createVendorAPI(inputValues: Record<string, string>) {
  // ============================================================
  // CLI 执行环境（登录凭据、项目绑定、子进程封装）
  // ============================================================

  /** CliResult: 一次 CLI 子进程调用的原始产物 */
  interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  const getCliPath = (): string => {
    const configured = (inputValues.cliPath ?? "").trim();
    // 配置的路径必须真实存在才采用：渠道配置里可能残留临时环境的路径（真实事故：
    // 调试会话把 cliPath 写成 /tmp/multica-task-*/libtv，环境清理后每次生成都 ENOENT）。
    // 不存在时降级到标准解析并告警，渠道保持可用而不是整条断掉。
    if (configured && fs.existsSync(configured)) return configured;
    if (configured) logger(`[LibTV] 渠道配置的 CLI 路径不存在: ${configured}，降级用默认解析（~/.libtv/libtv 或 PATH）`);
    const homeDefault = path.join(os.homedir(), ".libtv", "libtv");
    if (fs.existsSync(homeDefault)) return homeDefault;
    return "libtv"; // 兜底走 PATH
  };

  const getHomeDir = (): string => {
    const configured = (inputValues.homeDir ?? "").trim();
    if (configured) return configured;
    // 用户级绑定时（调用链注入 userId），凭据按用户隔离，互不串号
    const uid = (inputValues.userId ?? "").trim();
    return uid ? getPath(["libtv", "home", uid]) : getPath(["libtv", "home"]);
  };

  const getWorkDir = (): string => {
    const configured = (inputValues.workDir ?? "").trim();
    if (configured) return configured;
    const uid = (inputValues.userId ?? "").trim();
    return uid ? getPath(["libtv", "work", uid]) : getPath(["libtv", "work"]);
  };

  /**
   * 把设置页粘贴的 credentials.json 内容落到托管 HOME（服务端无法跑浏览器登录，
   * 凭据必须在有浏览器的机器上 `libtv login web` 生成后离线注入）。
   *
   * 凭据的 source of truth 是设置页字段（加密存库）或环境变量 LIBTV_CREDENTIALS
   * （K8s Secret 注入），优先级：设置页 > 环境变量。pod 本地那份 credentials.json
   * 只是每次调用前重新物化的临时文件，pod 重建不丢登录态。
   */
  const ensureCredentials = () => {
    const token = (inputValues.credentialsToken ?? "").trim() || (process.env.LIBTV_CREDENTIALS ?? "").trim();
    if (!token) return;
    const credPath = path.join(getHomeDir(), ".libtv", "credentials.json");
    try {
      if (fs.existsSync(credPath) && fs.readFileSync(credPath, "utf-8").trim() === token) return;
    } catch (e) {}
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, token, { mode: 0o600 });
    loginOkUntilByKey.set(getHomeDir(), 0); // 凭据变更后强制重新校验登录
  };

  /** 执行一条 CLI 命令。HOME 指向托管目录，凭据与项目绑定都隔离在 Toonflow 数据目录里。 */
  const runCli = (args: string[], timeoutMs = 120000): Promise<CliResult> => {
    ensureCredentials();
    const homeDir = getHomeDir();
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(getWorkDir(), { recursive: true });
    return new Promise((resolve, reject) => {
      execFile(
        getCliPath(),
        args,
        {
          cwd: getWorkDir(),
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          if (err && (err as any).killed) {
            return reject(new Error(`LibTV CLI 命令超时: libtv ${args.join(" ")}`));
          }
          if (err && (err as any).code === "ENOENT") {
            return reject(
              new Error(
                `找不到 LibTV CLI（${getCliPath()}）。请在服务器安装：curl -fL "https://liblibai-web-static.liblib.cloud/cli/latest/install-libtv-cli.sh" | bash，或在 LibTV 渠道设置的「CLI 可执行文件路径」里填写实际路径。`,
              ),
            );
          }
          // execFile 把非零退出码放进 err.code，这里仍要带回 stdout 供调用方解析
          resolve({ code: err ? Number((err as any).code) || 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
  };

  /** 抛出带 stderr 的可读错误 */
  const cliFail = (action: string, r: CliResult): Error => {
    const detail = (r.stderr || r.stdout || "").trim().split("\n").slice(0, 6).join("\n");
    return new Error(`LibTV CLI ${action} 失败:\n${detail}`);
  };

  // loginOkUntil 挂在实例闭包里会随"每任务新建实例"而失效（ai.ts/libtvImport.ts 每次调用都新建），
  // 提升为模块级并按 HOME 目录分键，跨实例、跨任务共享登录态
  const homeKey = getHomeDir();
  if (!loginOkUntilByKey.has(homeKey)) loginOkUntilByKey.set(homeKey, 0);
  const loginOkUntil = loginOkUntilByKey.get(homeKey)!;
  /** 登录检查（审计结论：account info 成功退出是唯一可靠的登录证明；结果缓存 10 分钟） */
  const ensureLogin = async (): Promise<void> => {
    if (Date.now() < loginOkUntilByKey.get(homeKey)!) return;
    const r = await runCli(["account", "info"], 30000);
    if (r.code !== 0) {
      throw new LibtvError(
        "AUTH_EXPIRED",
        "LibTV 授权已过期或未绑定。请在设置页「账号绑定」里重新绑定你的 LibTV 账号（短信验证码或粘贴凭据均可）。" +
          `\nCLI 输出: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`,
      );
    }
    loginOkUntilByKey.set(homeKey, Date.now() + 10 * 60 * 1000);
  };

  /** 自动绑定模式的专用画布项目名（匹配大小写不敏感；用户网页端同名画布会被直接复用） */
  const AUTO_PROJECT_NAME = "Toonflow";
  const byUpdatedDesc = (a: LibtvProjectInfo, b: LibtvProjectInfo) => (b.updateTime ?? "").localeCompare(a.updateTime ?? "");
  const findAutoProject = (projects: LibtvProjectInfo[]): LibtvProjectInfo | undefined =>
    projects.filter((p) => /^toonflow$/i.test(p.name.trim())).sort(byUpdatedDesc)[0];

  /** 绑定画布项目（写 <workDir>/.libtv/project.json），绑定后 node/upload 不用再带 -p。按 workDir+项目隔离缓存（模块级，跨实例共享），并发调用共享同一次绑定。 */
  const projectBindings = projectBindingsByKey;
  const ensureProject = async (): Promise<string> => {
    const wantedId = (inputValues.projectId ?? "").trim();
    const workDir = getWorkDir();
    const cacheKey = `${workDir}:${wantedId}`;
    const cached = projectBindings.get(cacheKey);
    if (cached) return cached;
    const task = (async () => {
      // 1. 显式配置的画布项目 ID 优先（管理员指定，直接信任）
      if (wantedId) {
        const r = await runCli(["project", "use", wantedId]);
        if (r.code !== 0) throw cliFail(`绑定画布项目 ${wantedId}`, r);
        return wantedId;
      }
      // 2. 自动模式：绑定文件里已绑定的画布要先确认它还在名下（用户可能在网页端删了画布），
      //    顺带用同一份 project list 做「找名为 Toonflow 的画布」——一次调用两个用途。
      //    真实 CLI（1.0.2 校准）：project use 写 {"projectUuid":"<32位无连字符hex>"}，list 条目是 {id, uuid, name, ...}。
      const bindFile = path.join(workDir, ".libtv", "project.json");
      let bound = "";
      try {
        const parsed = JSON.parse(fs.readFileSync(bindFile, "utf-8"));
        bound = String(parsed?.projectId ?? parsed?.projectUuid ?? parsed?.id ?? "");
      } catch (e) {
        // 无绑定文件或已损坏，走下面的自动绑定
      }
      let projects: LibtvProjectInfo[] = [];
      try {
        projects = await listProjects(); // 内部含 ensureLogin（生成链路已登录，缓存命中零开销）
      } catch (e) {
        if (bound) return bound; // 列表拉取的瞬时故障不该废掉仍有效的既有绑定
        throw e;
      }
      if (bound && projects.some((p) => p.id === bound)) return bound;
      // 3. 复用名下已有的 Toonflow 画布（历史失败重试可能建了多个，取最近更新的那个）
      const found = findAutoProject(projects);
      if (found) {
        const use = await runCli(["project", "use", found.id]);
        if (use.code !== 0) throw cliFail(`绑定画布项目 ${found.name}(${found.id})`, use);
        return found.id;
      }
      // 4. 名下没有 Toonflow 画布 → 自动创建。真实输出形如 {"projectMetaList":[{id,uuid,name,...}]}，
      //    uuid 是 32 位无连字符 hex——旧解析只认 projectUuid 键和带连字符 uuid，导致「画布建成了但解析不到 ID」
      const r = await runCli(["project", "create", AUTO_PROJECT_NAME], 60000);
      if (r.code !== 0) throw cliFail("创建画布项目", r);
      let created = "";
      for (const [keyPath, value] of walkEntries(parseCliJson(r.stdout))) {
        const leaf = keyPath.split(".").pop() ?? "";
        if (
          typeof value === "string" &&
          /^(uuid|projectUuid|projectId|projectID|projectKey)$/i.test(leaf) &&
          /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value)
        ) {
          created = value;
          break;
        }
      }
      if (!created) {
        // 创建输出解析不出来（格式可能再变）——画布大概率已建成，回列表按名字找（真实事故：画布已建但解析失败）
        const refreshed = findAutoProject(await listProjects());
        if (!refreshed) {
          throw new Error("无法从 libtv project create 输出中解析项目 ID，请在 LibTV 渠道设置里手动填写「画布项目 ID」（网页端画布 URL 的 projectId 参数）。\nCLI 输出: " + r.stdout.trim().slice(0, 300));
        }
        created = refreshed.id;
      }
      const use = await runCli(["project", "use", created]);
      if (use.code !== 0) throw cliFail(`绑定画布项目 ${created}`, use);
      return created;
    })();
    projectBindings.set(cacheKey, task);
    try {
      return await task;
    } catch (e) {
      projectBindings.delete(cacheKey); // 失败不缓存，下次重试
      throw e;
    }
  };

  // ============================================================
  // 模型显示名解析（-s model= 要的是显示名，schema 查询用的是 modelKey）
  // ============================================================

  const modelNameCache = sharedModelNameCache;
  const resolveModelDisplayName = async (type: "image" | "video", schemaKey: string): Promise<string> => {
    const cacheKey = `${type}:${schemaKey}`;
    const cached = modelNameCache.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.value;

    let displayName = "";
    try {
      const r = await runCli(["model", "search", "-t", type], 60000);
      if (r.code === 0) displayName = parseModelSearchOutput(r.stdout, schemaKey);
    } catch (e) {
      logger(`[LibTV] model search 失败，使用内置显示名兜底: ${e}`);
    }
    if (!displayName) displayName = KNOWN_MODEL_NAMES[schemaKey] ?? "";
    if (!displayName) {
      throw new Error(
        `无法确定 LibTV 模型「${schemaKey}」的创建用显示名。请先确认 CLI 已登录，手动执行 \`libtv model search -t ${type}\` 核对模型是否存在，再反馈该输出来更新 KNOWN_MODEL_NAMES。`,
      );
    }
    modelNameCache.set(cacheKey, { value: displayName, until: Date.now() + 10 * 60 * 1000 });
    return displayName;
  };

  /** 从 `libtv model search` 输出里找 schemaKey 对应的显示名。输出格式未公开，按 JSON/NDJSON/表格三种形态防御解析。 */
  const parseModelSearchOutput = (stdout: string, schemaKey: string): string => {
    const objs: any[] = [];
    const trimmed = stdout.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) objs.push(...parsed);
      else if (parsed && typeof parsed === "object") objs.push(...(Array.isArray(parsed.models) ? parsed.models : [parsed]));
    } catch (e) {
      for (const line of trimmed.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(t);
          if (parsed && typeof parsed === "object") objs.push(parsed);
        } catch (e) {}
      }
    }
    const pick = (o: any): string => o?.modelName ?? o?.display_name ?? o?.displayName ?? "";
    for (const o of objs) {
      const key = o?.modelKey ?? o?.model_key ?? o?.key ?? o?.id;
      if (typeof key === "string" && key.trim() === schemaKey) {
        const name = pick(o);
        if (name) return name;
      }
    }
    // 纯文本形态：每行 "modelKey  显示名"
    for (const line of trimmed.split("\n")) {
      const m = line.trim().match(/^(\S+)\s{2,}(.+)$/);
      if (m && m[1] === schemaKey) return m[2].trim();
    }
    return "";
  };

  /**
   * 拉取模型 schema（`libtv model <key>`，真实输出 {schema:{properties:{...}}}, 1.0.2 校准）。
   * 生成参数按 schema 白名单裁剪：真实事故——image 模型的比例字段是 ratio 而非 aspectRatio，
   * 盲传未知字段会被「params 顶层不允许设置未知字段」整单拒绝。
   */
  const resolveModelSchema = async (schemaKey: string): Promise<LibtvModelSchema | null> => {
    const cached = sharedModelSchemaCache.get(schemaKey);
    if (cached && cached.until > Date.now()) return cached.value;
    let parsed: LibtvModelSchema | null = null;
    try {
      const r = await runCli(["model", schemaKey], 60000);
      if (r.code === 0) {
        const root = parseCliJson(r.stdout);
        const propsObj = root?.schema?.properties;
        if (propsObj && typeof propsObj === "object") {
          const props = new Set(Object.keys(propsObj));
          const enums: Record<string, string[]> = {};
          for (const [field, def] of Object.entries(propsObj as Record<string, any>)) {
            if (!def || typeof def !== "object") continue;
            // 允许值两种形态（真实 1.0.2 schema）：enum 数组（元素为字符串或 {value}），或 items 对象（键 = 允许的 modeType 值）
            const raw: any[] = Array.isArray(def.enum) ? def.enum : def.items && typeof def.items === "object" && !Array.isArray(def.items) ? Object.keys(def.items) : [];
            const values = raw
              .map((e: any) => (typeof e === "string" ? e : e && typeof e === "object" && typeof e.value === "string" ? e.value : null))
              .filter((v: any): v is string => typeof v === "string");
            if (values.length > 0) enums[field] = values;
          }
          parsed = { props, enums };
        }
      }
    } catch (e) {
      logger(`[LibTV] 拉取模型 schema 失败，参数将按旧规则直传: ${String((e as any)?.message ?? e).slice(0, 120)}`);
    }
    sharedModelSchemaCache.set(schemaKey, { value: parsed, until: Date.now() + 10 * 60 * 1000 });
    return parsed;
  };

  /** schema 白名单裁剪：字段不在 schema 里 → 丢弃；值不在枚举里 → 丢弃（吃平台默认值）；schema 拿不到 → 维持直传 */
  const pickParam = (schema: LibtvModelSchema | null, field: string, value: string): string | null => {
    if (!schema) return value;
    if (!schema.props.has(field)) return null;
    const allowed = schema.enums[field];
    if (allowed && !allowed.includes(value)) return null;
    return value;
  };

  // ============================================================
  // 参考图上传（base64 落盘 → libtv upload → 节点 key）
  // ============================================================

  /** 从 CLI 的 NDJSON/JSON 输出中提取新节点标识 */
  const extractNodeKey = (stdout: string): string =>
    stdout.match(/"(?:newNodeKey|nodeKey)"\s*:\s*"([^"]+)"/)?.[1] ?? "";

  /** 把参考图上传成画布资源节点，返回可用于 --left 的节点标识（优先 key，兜底用节点名） */
  const uploadReference = async (index: number, ref: ReferenceList): Promise<string> => {
    const extMap: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4", "audio/mpeg": ".mp3" };
    const dataUrl = ref.base64 ?? "";
    const mime = dataUrl.match(/^data:([^;,]+)[;,]/)?.[1] ?? (ref.type === "video" ? "video/mp4" : ref.type === "audio" ? "audio/mpeg" : "image/png");
    const tmpDir = path.join(getWorkDir(), "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `tf_ref_${index}_${crypto.randomUUID()}${extMap[mime] ?? ".bin"}`);
    const rawB64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
    fs.writeFileSync(filePath, Buffer.from(rawB64, "base64"));
    try {
      const nodeName = `tf-ref-${index}-${crypto.randomUUID().slice(0, 8)}`;
      const typeArg = ref.type === "video" ? "video" : ref.type === "audio" ? "audio" : "image";
      const r = await runCli(["upload", nodeName, "-f", filePath, "-t", typeArg], 300000);
      if (r.code !== 0) throw cliFail(`上传参考文件 ${index + 1}`, r);
      return extractNodeKey(r.stdout) || nodeName;
    } finally {
      fs.rm(filePath, { force: true }, () => {});
    }
  };

  // ============================================================
  // 节点状态解析（输出格式未公开，防御式解析）
  // ============================================================

  /** 深度收集 [keyPath, value] 对 */
  const walkEntries = (node: any, prefix = ""): [string, any][] => {
    const out: [string, any][] = [];
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) {
      node.forEach((item, i) => out.push(...walkEntries(item, `${prefix}[${i}]`)));
      return out;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        const keyPath = prefix ? `${prefix}.${k}` : k;
        out.push(...walkEntries(v, keyPath));
      }
      return out;
    }
    out.push([prefix, node]);
    return out;
  };

  const STATUS_DONE = new Set(["success", "succeed", "succeeded", "completed", "complete", "done", "finished", "generated"]);
  const STATUS_FAILED = new Set(["fail", "failed", "failure", "error", "rejected", "censored", "moderated", "timeout"]);

  /**
   * 解析 `libtv node <name>` 的输出。
   * 已知线索（CLI 1.0.2 审计）：节点不存在时输出含 count:0 或 matches:[]。
   * 状态与结果字段名未公开，按常见命名启发式匹配，解析不出来时报出原文片段供校准。
   */
  const parseNodeOutput = (stdout: string, kind: "image" | "video"): { exists: boolean; done?: boolean; failed?: boolean; failReason?: string; resultUrl?: string } => {
    const trimmed = stdout.trim();
    // 先找 JSON（整体或逐行 NDJSON），找不到再退化到文本标记
    let root: any = null;
    try {
      root = JSON.parse(trimmed);
    } catch (e) {
      for (const line of trimmed.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          root = JSON.parse(t);
        } catch (e) {}
      }
    }
    const absentByText = /"count"\s*:\s*0|"matches"\s*:\s*\[\s*\]/.test(trimmed);
    if (!root) {
      // 真实 CLI（1.0.2 校准）：节点不存在时输出纯文本「未找到展示名或节点 id 与该字符串完全一致的节点」，退出码 0
      if (absentByText || /未找到|not\s+found/i.test(trimmed)) return { exists: false };
      throw new Error("无法解析 libtv node 输出（非 JSON），请把以下输出来反馈以校准解析器:\n" + trimmed.slice(0, 600));
    }
    if (root.count === 0 || (Array.isArray(root.matches) && root.matches.length === 0)) return { exists: false };

    const nodeObj = Array.isArray(root.matches) && root.matches.length > 0 ? root.matches[0] : root;
    const entries = walkEntries(nodeObj);

    // 1) 状态：匹配 key 形如 status/state/taskStatus... 的字符串或布尔
    let done = false;
    let failed = false;
    let running = false;
    let failReason = "";
    for (const [keyPath, value] of entries) {
      const leaf = keyPath.split(".").pop() ?? "";
      if (!/^(status|state|taskStatus|generateStatus|runStatus|run_state)$/i.test(leaf)) continue;
      const v = String(value).toLowerCase();
      if (STATUS_DONE.has(v)) done = true;
      else if (STATUS_FAILED.has(v)) failed = true;
    }
    for (const [keyPath, value] of entries) {
      const leaf = keyPath.split(".").pop() ?? "";
      if (/^(success|succeed|completed|done|finished)$/i.test(leaf) && value === true) done = true;
      if (/^(failed|error|failure)$/i.test(leaf) && value === true) failed = true;
      if (/^is(Running|Generating|Processing)$/i.test(leaf) && value === true) {
        done = false;
        running = true;
      }
    }
    for (const [keyPath, value] of entries) {
      if (!failReason && typeof value === "string" && /^(error|message|errorMessage|errorReason|failReason|failure_reason|reason)$/i.test(keyPath.split(".").pop() ?? "")) {
        failReason = value;
      }
    }

    // 1.5) 结果 URL 已就绪即视为完成（真实校准：产出在 data.url 数组里，完成态可能没有可识别的 status 字段；
    //      未运行的节点 url 为空数组不会命中；平台明确标记 running 时以 running 为准）
    const hasResultUrl = entries.some(([keyPath, value]) => {
      if (typeof value !== "string" || !/^https?:\/\//.test(value)) return false;
      const leaf = (keyPath.split(".").pop() ?? "").replace(/\[\d+\]$/, "");
      if (/^(left|input|ref|source|prev|origin)/i.test(keyPath)) return false;
      return /(result|output|download|videoUrl|imageUrl|fileUrl|url)$/i.test(leaf) || /\.(mp4|mov|webm|png|jpe?g|webp|gif)(\?|$)/i.test(value);
    });
    if (!done && !failed && !running && hasResultUrl) done = true;

    // 2) 结果 URL：优先扩展名匹配，参考图输入字段降权
    const extRe = kind === "video" ? /\.(mp4|mov|webm)(\?|$)/i : /\.(png|jpe?g|webp|gif)(\?|$)/i;
    let best: { url: string; score: number } | null = null;
    for (const [keyPath, value] of entries) {
      if (typeof value !== "string" || !/^https?:\/\//.test(value)) continue;
      const leaf = (keyPath.split(".").pop() ?? "").replace(/\[\d+\]$/, "");
      let score = 0;
      if (extRe.test(value)) score += 3;
      if (/(result|output|download|videoUrl|imageUrl|fileUrl|url)$/i.test(leaf)) score += 2;
      if (/(result|output|taskinfo|task_info)/i.test(keyPath)) score += 2;
      if (/(left|input|ref|source|prev|origin)/i.test(keyPath)) score -= 5;
      if (score <= 0) continue;
      if (!best || score > best.score) best = { url: value, score };
    }
    return { exists: true, done, failed, failReason, resultUrl: best?.url };
  };

  // ============================================================
  // 通用：创建节点 → 轮询 → 取结果 URL
  // ============================================================

  const pollNodeResult = async (nodeName: string, kind: "image" | "video", intervalMs: number, timeoutMs: number): Promise<string> => {
    const result = await pollTask(async (): Promise<PollResult> => {
      let r: { code: number; stdout: string; stderr: string };
      try {
        r = await runCli(["node", nodeName], 60000);
      } catch (e: any) {
        // 查询本身失败（含 CLI 超时、CLI 缺失外的瞬时错误）不算生成失败，下一轮重试。
        // 不捕获的话 rejection 会直接终止整个轮询，把跑了十几分钟的生成废掉（runCli 超时走 reject 而非非零退出码）。
        logger(`[LibTV] 查询节点 ${nodeName} 异常，下一轮重试: ${String(e?.message ?? e).slice(0, 200)}`);
        return { completed: false };
      }
      // 查询本身失败（含 CLI 超时）不算生成失败，下一轮重试
      if (r.code !== 0 && !r.stdout.trim()) {
        logger(`[LibTV] 查询节点 ${nodeName} 出错，继续轮询: ${(r.stderr || "").trim().slice(0, 200)}`);
        return { completed: false };
      }
      const parsed = parseNodeOutput(r.stdout, kind);
      if (!parsed.exists) return { completed: true, error: `LibTV 节点 ${nodeName} 不存在（创建可能未生效）` };
      if (parsed.failed) return { completed: true, error: `LibTV 生成失败: ${parsed.failReason || "未返回失败原因（含真人形象的参考图会被平台合规墙拦截）"}` };
      if (parsed.done) {
        if (parsed.resultUrl) return { completed: true, data: parsed.resultUrl };
        // 完成但没解析到 URL：报出原文便于校准，而不是无限轮询
        return {
          completed: true,
          error: `LibTV 节点 ${nodeName} 已完成，但未从输出中解析到结果 URL，请把 libtv node ${nodeName} 的输出来反馈以校准解析器`,
        };
      }
      return { completed: false };
    }, intervalMs, timeoutMs);
    if (result.error === "timeout") throw new LibtvError("GENERATION_TIMEOUT", "LibTV 生成时间较长，已转入后台继续处理，请稍后在任务中心或 LibTV 画布上确认结果");
    if (result.error) throw new LibtvError(classifyLibtvFailure(result.error), result.error);
    if (!result.data) throw new LibtvError("UNKNOWN", "LibTV 生成未返回结果");
    return result.data;
  };

  /** --left 引用顺序 = 上游引用顺序，与 prompt 里 {{Image N}} 对应 */
  const buildReferenceNote = (modeType: string, refCount: number): string => {
    if (refCount <= 0) return "";
    if (modeType === "image2video") {
      const slots = Array.from({ length: refCount }, (_, i) => `{{Image ${i + 1}}}`).join("、");
      return `参考图依次为 ${slots}，请保持画面主体形象与参考图一致。`;
    }
    return "";
  };

  /** VideoMode → LibTV modeType。运行时 mode 可能是字符串、单条数组或目录里的嵌套数组形态，统一摊平再判断。 */
  const resolveModeType = (mode: VideoMode | VideoMode[] | undefined, imageCount: number, videoCount: number, audioCount: number): string => {
    const entries = (Array.isArray(mode) ? mode : mode ? [mode] : []).flatMap((m) => (Array.isArray(m) ? m : [String(m)]));
    for (const m of entries) {
      if (m.startsWith("imageReference:")) return "image2video";
      if (m.startsWith("videoReference:") || m.startsWith("audioReference:")) return "mixed2video";
    }
    for (const m of entries) {
      switch (m) {
        case "text":
          return "text2video";
        case "singleImage":
          return "singleImage2video";
        case "startEndRequired":
        case "endFrameOptional":
        case "startFrameOptional":
          return "frames2video";
      }
    }
    // 未声明模式时按参考数量推断
    if (videoCount > 0 || audioCount > 0) return "mixed2video";
    if (imageCount > 2) return "image2video";
    if (imageCount === 2) return "frames2video";
    if (imageCount === 1) return "singleImage2video";
    return "text2video";
  };

  // ============================================================
  // 画布回读与节点清理（「从 LibTV 导入」导入器 + 防画布膨胀）
  // ============================================================

  /** 从节点对象里按扩展名/字段名启发式挑出产物 URL（与 parseNodeOutput 同思路，面向画布回读的批量节点） */
  const extractCanvasNodeUrl = (nodeObj: any, kind: "image" | "video" | "audio"): string => {
    const extRe = kind === "video" ? /\.(mp4|mov|webm)(\?|$)/i : kind === "audio" ? /\.(mp3|wav|ogg|aac|flac|m4a)(\?|$)/i : /\.(png|jpe?g|webp|gif)(\?|$)/i;
    let best = "";
    let bestScore = 0;
    for (const [keyPath, value] of walkEntries(nodeObj)) {
      if (typeof value !== "string" || !/^https?:\/\//.test(value)) continue;
      const leaf = (keyPath.split(".").pop() ?? "").replace(/\[\d+\]$/, "");
      let score = 0;
      if (extRe.test(value)) score += 3;
      if (/(url|src|href|file|resource|download)$/i.test(leaf)) score += 1;
      // 输入/缩略图字段降权：导入要的是产物原图/原片，不是参考图或封面
      if (/(left|input|ref|source|prev|origin|thumb|cover|icon|poster)/i.test(keyPath)) score -= 4;
      if (score > bestScore) {
        bestScore = score;
        best = value;
      }
    }
    return bestScore > 0 ? best : "";
  };

  const inferKindFromUrl = (url: string): LibtvCanvasNode["type"] => {
    if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) return "video";
    if (/\.(mp3|wav|ogg|aac|flac|m4a)(\?|$)/i.test(url)) return "audio";
    if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return "image";
    return "other";
  };

  /** 解析 `libtv project <uuid>` 列表输出：节点只有 key/name/type/位置信息，产物 URL 要逐节点 `libtv node <key> -p <uuid>` 查询（1.0.2 校准）。 */
  const parseCanvasNodeList = (stdout: string): { key: string; name: string; type: LibtvCanvasNode["type"] }[] => {
    const root = parseCliJson(stdout);
    if (!root) {
      const trimmed = String(stdout ?? "").trim();
      if (!trimmed) return [];
      throw new Error("无法解析 libtv project 输出（非 JSON），请把以下输出来反馈以校准导入器解析器:\n" + trimmed.slice(0, 600));
    }
    const nodeArr = Array.isArray(root) ? root : Array.isArray(root?.nodes) ? root.nodes : Array.isArray(root?.matches) ? root.matches : Array.isArray(root?.elements) ? root.elements : [];
    const out: { key: string; name: string; type: LibtvCanvasNode["type"] }[] = [];
    for (const item of nodeArr) {
      if (!item || typeof item !== "object") continue;
      const key = String(item.nodeKey ?? item.key ?? item.nodeId ?? item.id ?? "").slice(0, 120);
      if (!key) continue;
      const rawType = String(item.nodeType ?? item.type ?? item.category ?? "").toLowerCase();
      let type: LibtvCanvasNode["type"] = "other";
      if (/video|film|movie/.test(rawType)) type = "video";
      else if (/audio|music|sound|voice|tts/.test(rawType)) type = "audio";
      else if (/image|picture|photo|draw|paint/.test(rawType)) type = "image";
      // 只收编媒体类型节点；纯文本/脚本/分组节点没有产物
      if (type === "other") continue;
      out.push({
        key,
        name: String(item.name ?? item.title ?? "").slice(0, 100) || key,
        type,
      });
    }
    return out;
  };

  /** 单节点详情 → 产物节点：URL 在 data.url（字符串数组），prompt/时间等元数据尽力提取（真实格式 1.0.2 校准）。 */
  const parseNodeDetail = (stdout: string, fallbackType: LibtvCanvasNode["type"], fallbackName: string): Partial<LibtvCanvasNode> | null => {
    const detail = parseCliJson(stdout);
    if (!detail || typeof detail !== "object") return null;
    const rawType = String(detail.nodeType ?? detail.data?.type ?? detail.type ?? "").toLowerCase();
    let type: LibtvCanvasNode["type"] = "other";
    if (/video|film|movie/.test(rawType)) type = "video";
    else if (/audio|music|sound|voice|tts/.test(rawType)) type = "audio";
    else if (/image|picture|photo|draw|paint/.test(rawType)) type = "image";
    if (type === "other") type = fallbackType;
    // data.url 是字符串数组（真实格式）；walkEntries 兜底扫任意字段
    const urls: string[] = Array.isArray(detail.data?.url)
      ? detail.data.url.filter((u: unknown) => typeof u === "string" && /^https?:\/\//.test(u as string))
      : [];
    let url = urls[0] ?? extractCanvasNodeUrl(detail, type === "other" ? "image" : type);
    if (!url && type !== "video" && type !== "audio") url = extractCanvasNodeUrl(detail, "image");
    if (!url) return null;
    const inferred = inferKindFromUrl(url);
    if (inferred !== "other") type = inferred;
    let prompt = "";
    for (const [keyPath, value] of walkEntries(detail)) {
      if (typeof value !== "string" || !value.trim() || /^https?:\/\//.test(value)) continue;
      const leaf = keyPath.split(".").pop() ?? "";
      if (/^(prompt|promptText|description|desc)$/i.test(leaf)) {
        prompt = value.trim().slice(0, 2000);
        break;
      }
    }
    const rawTime = detail.data?.createTime ?? detail.createTime ?? detail.createdAt ?? detail.data?.updatedAtMs;
    const timeNum = Number(rawTime);
    return {
      type,
      prompt,
      url,
      createTime: Number.isFinite(timeNum) && timeNum > 0 ? new Date(timeNum).toISOString() : undefined,
      name: String(detail.name ?? "").slice(0, 100) || fallbackName,
    };
  };

  /** 列出账号名下的画布项目（导入器第一步）。审计：未登录时返回空列表且退出码 0，调用方须先 ensureLogin。 */
  const listProjects = async (): Promise<LibtvProjectInfo[]> => {
    await ensureLogin();
    const r = await runCli(["project", "list"], 60000);
    if (r.code !== 0) throw new LibtvError(classifyLibtvFailure(r.stderr || r.stdout), `列出画布项目失败:\n${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
    const root = parseCliJson(r.stdout);
    if (!root) {
      const trimmed = r.stdout.trim();
      if (!trimmed) return [];
      throw new Error("无法解析 libtv project list 输出（非 JSON），请把以下输出来反馈以校准解析器:\n" + trimmed.slice(0, 600));
    }
    const arr = Array.isArray(root)
      ? root
      : Array.isArray(root?.projectMetaList)
        ? root.projectMetaList
        : Array.isArray(root?.projects)
          ? root.projects
          : Array.isArray(root?.matches)
            ? root.matches
            : [];
    const out: LibtvProjectInfo[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      // 真实 CLI 输出（1.0.2 校准）：{ id, uuid, name, updatedAtMs, createdAtMs }；
      // `libtv project <id>` 回读只认 uuid，这里优先取 uuid
      const pid = item.uuid ?? item.projectUuid ?? item.projectId ?? item.id;
      if (!pid) continue;
      const rawTime = item.updatedAtMs ?? item.updateTime ?? item.createdAtMs ?? item.createTime;
      const timeNum = Number(rawTime);
      out.push({
        id: String(pid),
        name: String(item.name ?? item.title ?? item.projectName ?? "").slice(0, 100) || String(pid),
        updateTime: Number.isFinite(timeNum) && timeNum > 0 ? new Date(timeNum).toISOString() : undefined,
      });
    }
    return out;
  };

  /** 单画布逐节点查询上限：每个节点一次 CLI 调用，防超大画布拖垮导入（超出部分可在 LibTV 网页端处理） */
  const CANVAS_NODE_QUERY_LIMIT = 200;

  /** 回读画布的产物节点（导入器第二步）：列表拿 key/type → 逐节点 `libtv node <key> -p <uuid>` 拿产物 URL。 */
  const readProjectCanvas = async (projectId: string): Promise<LibtvCanvasNode[]> => {
    await ensureLogin();
    const r = await runCli(["project", String(projectId)], 120000);
    if (r.code !== 0) throw new LibtvError(classifyLibtvFailure(r.stderr || r.stdout), `读取画布 ${projectId} 失败:\n${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
    const listed = parseCanvasNodeList(r.stdout);
    const out: LibtvCanvasNode[] = [];
    for (const node of listed) {
      if (out.length >= CANVAS_NODE_QUERY_LIMIT) {
        logger(`[LibTV] 画布 ${projectId} 产物节点超过 ${CANVAS_NODE_QUERY_LIMIT}，截断导入列表`);
        break;
      }
      try {
        // 真实 CLI 契约：node 查询需要 -p <项目uuid>（或 cwd 有 project use 写入的绑定文件；导入链路 cwd 是 HOME，必须显式传）
        const nr = await runCli(["node", node.key, "-p", String(projectId)], 60000);
        const detail = parseNodeDetail(nr.stdout, node.type, node.name);
        if (!detail) continue;
        out.push({
          key: node.key,
          name: detail.name ?? node.name,
          type: detail.type ?? node.type,
          prompt: detail.prompt ?? "",
          url: detail.url ?? "",
          createTime: detail.createTime,
        });
      } catch (e) {
        logger(`[LibTV] 查询画布节点 ${node.key} 失败，跳过: ${String((e as any)?.message ?? e).slice(0, 120)}`);
      }
    }
    return out;
  };

  /** 删除画布节点（`node delete`/`node remove` 双命令兜底，输出格式未公开，删除失败不抛错只返回 false）。 */
  const deleteNode = async (nodeName: string): Promise<boolean> => {
    for (const args of [["node", "delete", nodeName], ["node", "remove", nodeName]]) {
      try {
        const r = await runCli(args, 60000);
        if (r.code === 0) return true;
      } catch (e) {}
    }
    logger(`[LibTV] 清理临时节点 ${nodeName} 失败（不影响生成结果）`);
    return false;
  };

  // 节点清理走「延迟队列」：删除画布节点可能使产物 URL 失效，而调用方（Ai.Image/Video）拿到 URL 后
  // 才下载转存，所以成功生成后先登记，下一次生成开始时再删——画布最多滞留一轮的临时节点，下载安全不受影响。
  const CLEANUP_QUEUE_FILE = "pending-node-cleanup.json";
  const isCleanupEnabled = (): boolean => /^(\s*1|true|on|yes|y|开启|是)\s*$/i.test((inputValues.deleteNodeAfterGen ?? "").trim());
  const queueNodeCleanup = (nodeName: string) => {
    if (!isCleanupEnabled()) return;
    try {
      const file = path.join(getWorkDir(), CLEANUP_QUEUE_FILE);
      const pending: string[] = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!pending.includes(nodeName)) pending.push(nodeName);
      fs.writeFileSync(file, JSON.stringify(pending.slice(-50)), { mode: 0o600 }); // 上限 50，防队列本身膨胀
    } catch (e) {
      try {
        fs.mkdirSync(getWorkDir(), { recursive: true });
        fs.writeFileSync(path.join(getWorkDir(), CLEANUP_QUEUE_FILE), JSON.stringify([nodeName]), { mode: 0o600 });
      } catch (e2) {}
    }
  };
  const flushNodeCleanup = async () => {
    if (!isCleanupEnabled()) return;
    try {
      const file = path.join(getWorkDir(), CLEANUP_QUEUE_FILE);
      const pending: string[] = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!Array.isArray(pending) || pending.length === 0) return;
      fs.writeFileSync(file, JSON.stringify([]), { mode: 0o600 }); // 先清队列再删，失败不重试避免死循环
      for (const name of pending) await deleteNode(name);
    } catch (e) {}
  };

  // ============================================================
  // 适配器函数
  // ============================================================

  const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
    throw new Error("LibTV CLI 渠道暂不支持文本模型，请为 Agent 配置其它文本渠道");
  };

  const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
    await ensureLogin();
    await ensureProject();
    await flushNodeCleanup();
    const displayName = await resolveModelDisplayName("image", model.modelName);

    const refs = config.referenceList ?? [];
    const lefts: string[] = [];
    for (let i = 0; i < refs.length; i++) {
      lefts.push(await uploadReference(i, refs[i]));
    }

    // 参数按模型 schema 白名单裁剪（nebula 的比例字段叫 ratio 不叫 aspectRatio；quality 枚举各模型不同）
    const modelSchema = await resolveModelSchema(model.modelName);
    const ratio = pickParam(modelSchema, "ratio", config.aspectRatio);
    const quality = pickParam(modelSchema, "quality", config.size);

    const nodeName = `tf-img-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    const args = ["node", "create", nodeName, "-t", "image", "--prompt", config.prompt];
    for (const left of lefts) args.push("--left", left);
    args.push("-s", `model=${displayName}`);
    if (ratio) args.push("-s", `ratio=${ratio}`);
    if (quality) args.push("-s", `quality=${quality}`);
    args.push("--run");

    logger(`[LibTV] 创建图片节点 ${nodeName}, model=${displayName}, refs=${lefts.length}`);
    let created = false;
    try {
      const r = await runCli(args, 180000);
      if (r.code !== 0) throw cliFail("创建图片节点", r);
      created = true;
    } catch (e: any) {
      // 审计经验：--run 前台超时但后端作业可能仍在继续，先查节点再定论
      if (!String(e.message ?? "").includes("超时")) throw e;
      logger(`[LibTV] 创建图片节点超时，转入轮询确认: ${nodeName}`);
    }

    // create-then-verify：确认节点确实落到了画布上再进入轮询（查询失败则交给轮询兜底）
    try {
      const check = await runCli(["node", nodeName], 60000);
      if (!created && parseNodeOutput(check.stdout, "image").exists === false) {
        throw new Error(`LibTV 图片节点 ${nodeName} 创建失败（节点不存在），请检查渠道配置与登录状态`);
      }
    } catch (e: any) {
      if (String(e.message ?? "").includes("创建失败")) throw e;
      logger(`[LibTV] 确认图片节点存在性出错，交由轮询兜底: ${e}`);
    }
    const resultUrl = await pollNodeResult(nodeName, "image", 5000, 600000);
    queueNodeCleanup(nodeName);
    return resultUrl;
  };

  const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
    await ensureLogin();
    await ensureProject();
    await flushNodeCleanup();
    const displayName = await resolveModelDisplayName("video", model.modelName);

    const refs = config.referenceList ?? [];
    const imageRefs = refs.filter((r) => r.type === "image");
    const videoRefs = refs.filter((r) => r.type === "video");
    const audioRefs = refs.filter((r) => r.type === "audio");
    const modeType = resolveModeType(config.mode, imageRefs.length, videoRefs.length, audioRefs.length);

    const lefts: string[] = [];
    for (let i = 0; i < refs.length; i++) {
      lefts.push(await uploadReference(i, refs[i]));
    }

    // StarVideo 2.0 schema 允许值裁剪（越界值会被模型 schema 校验拒绝）
    const duration = Math.min(VIDEO_DURATION_MAX, Math.max(VIDEO_DURATION_MIN, Math.round(config.duration)));
    const resolution = VIDEO_RESOLUTIONS.includes(config.resolution) ? config.resolution : "720p";
    const ratio = VIDEO_RATIOS.includes(config.aspectRatio) ? config.aspectRatio : "16:9";
    const enableSound = config.audio === false ? "off" : "on";
    const fullPrompt = [buildReferenceNote(modeType, lefts.length), config.prompt].filter(Boolean).join("\n");

    // 参数按模型 schema 白名单裁剪：modeType=text2video 不在 StarVideo 枚举里时自动省略（平台按无该字段处理）
    const modelSchema = await resolveModelSchema(model.modelName);
    const schemaParams: [string, string][] = (
      [
        ["modeType", modeType],
        ["ratio", ratio],
        ["resolution", resolution],
        ["duration", String(duration)],
        ["enableSound", enableSound],
      ] as [string, string][]
    )
      .map(([field, value]) => [field, pickParam(modelSchema, field, value)] as [string, string | null])
      .filter((p): p is [string, string] => p[1] !== null);

    const nodeName = `tf-vid-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    const args = ["node", "create", nodeName, "-t", "video", "--prompt", fullPrompt];
    for (const left of lefts) args.push("--left", left);
    args.push("-s", `model=${displayName}`);
    for (const [field, value] of schemaParams) args.push("-s", `${field}=${value}`);
    args.push("--run");

    logger(`[LibTV] 创建视频节点 ${nodeName}, model=${displayName}, modeType=${modeType}, ${duration}s/${resolution}/${ratio}, sound=${enableSound}, refs=${lefts.length}`);
    let created = false;
    try {
      const r = await runCli(args, 180000);
      if (r.code !== 0) throw cliFail("创建视频节点", r);
      created = true;
    } catch (e: any) {
      if (!String(e.message ?? "").includes("超时")) throw e;
      logger(`[LibTV] 创建视频节点超时，转入轮询确认: ${nodeName}`);
    }

    // create-then-verify：确认节点确实落到了画布上再进入轮询（查询失败则交给轮询兜底）
    try {
      const check = await runCli(["node", nodeName], 60000);
      if (!created && parseNodeOutput(check.stdout, "video").exists === false) {
        throw new Error(`LibTV 视频节点 ${nodeName} 创建失败（节点不存在），请检查渠道配置与登录状态`);
      }
    } catch (e: any) {
      if (String(e.message ?? "").includes("创建失败")) throw e;
      logger(`[LibTV] 确认视频节点存在性出错，交由轮询兜底: ${e}`);
    }
    // 视频生成耗时较长，与其它渠道对齐：10s 间隔，最长 30 分钟
    const resultUrl = await pollNodeResult(nodeName, "video", 10000, 1800000);
    queueNodeCleanup(nodeName);
    return resultUrl;
  };

  const ttsRequest = async (config: TTSConfig, model: TTSModel, inputValues: Record<string, string>): Promise<string> => {
    throw new Error("LibTV CLI 渠道暂不支持配音模型");
  };

  const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
    return { hasUpdate: false, latestVersion: "1.0", notice: "初始版本" };
  };

  const updateVendor = async (): Promise<string> => {
    return "";
  };

  // ============================================================
  // 导出
  // ============================================================

  return { textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor, listProjects, readProjectCanvas, deleteNode, ensureProject };
}
