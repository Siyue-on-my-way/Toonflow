import axios from "axios";
import { v4 as uuid } from "uuid";
import u from "@/utils";
import { LibtvCanvasNode, LibtvProjectInfo, LibtvError, parseCliJson } from "@/vendors/libtv";
import libtvBinding from "@/utils/libtvBinding";
import { createChatMedia, markChatMediaDone } from "@/lib/quickVideo/media";

/**
 * 「从 LibTV 导入」资源导入器（一次性收编，只读不写回）。
 *
 * 把用户在 LibTV 画布上的存量产物（图/视频/音频）下载后收进 Toonflow 素材库：
 *   project list → 用户选画布 → project <id> 回读产物节点 → 勾选下载 → 存 MinIO + o_assets。
 * 原则：导入是单向收编，不在 LibTV 侧写任何东西；也不回读生成历史/积分（平台接口拿不到）。
 *
 * 来源标记与去重：o_assets.remark 写「来源: LibTV」并在其中携带画布节点 key
 * （`来源: LibTV · 节点 <key>`），同项目重复导入同一节点时跳过，导入即可幂等。
 */

const VENDOR_ID = "libtv";
const SOURCE_TAG = "来源: LibTV";

/** 归属校验（SIY-172 审查 P1-6 IDOR）：toonflowProjectId 必须属于当前用户，否则拒绝（404 语义由调用方转成 error 消息） */
export async function assertProjectOwnership(userId: number, toonflowProjectId: number): Promise<void> {
  const row = await u.db("o_project").where({ id: toonflowProjectId }).first("userId");
  if (!row || row.userId !== userId) {
    throw new LibtvError("UNKNOWN", `目标项目不存在或不属于当前用户（projectId=${toonflowProjectId}）`);
  }
}
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 500 * 1024 * 1024; // 单文件 500MB 上限，防异常 URL 拖爆内存

/** 组装以指定用户身份执行的 LibTV vendor API：用户级凭据覆盖渠道全局值，userId 注入 per-user HOME/work 目录 */
async function createUserLibtvAPI(userId: number) {
  const binding = await libtvBinding.getBinding(userId);
  if (!binding.bound) {
    throw new LibtvError("NOT_BOUND", "尚未绑定 LibTV 账号，请先在设置页或模型选择器里完成绑定");
  }
  const row = await u.db("o_vendorConfig").where("id", VENDOR_ID).first();
  let channelValues: Record<string, string> = {};
  try {
    channelValues = JSON.parse(row?.inputValues ?? "{}");
  } catch (e) {}
  // 渠道级非密钥配置（cliPath/homeDir/workDir/projectId）保留作为缺省；密钥字段解密
  const inputValues: Record<string, string> = { ...channelValues };
  for (const key in inputValues) {
    if (typeof inputValues[key] === "string" && (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("token"))) {
      inputValues[key] = u.crypto.decrypt(inputValues[key]);
    }
  }
  const accountRow = await u.db("o_vendorAccount").where({ userId, vendorId: VENDOR_ID }).first();
  try {
    const userValues = JSON.parse(accountRow?.inputValues ?? "{}");
    if (userValues.credentialsToken) inputValues.credentialsToken = u.crypto.decrypt(userValues.credentialsToken);
  } catch (e) {}
  // per-user 隔离：凭据 HOME 与画布绑定目录都落到用户名下，画布项目 ID 不继承渠道全局值（那是平台公共画布）
  inputValues.userId = String(userId);
  delete inputValues.projectId;
  const vendorModule = u.vendor.getVendorModule(VENDOR_ID);
  if (!vendorModule) throw new Error(`未找到供应商模块 ${VENDOR_ID}`);
  return vendorModule.createVendorAPI(inputValues);
}

/** 第一步：列出用户名下的 LibTV 画布项目 */
export async function listUserProjects(userId: number): Promise<LibtvProjectInfo[]> {
  const api = await createUserLibtvAPI(userId);
  return api.listProjects();
}

export interface CanvasNodeWithOptions extends LibtvCanvasNode {
  imported: boolean; // 该节点此前已导入过当前项目
}

/** 第二步：回读画布产物节点，并标注哪些已导入过当前项目（按 remark 里的节点 key 幂等去重） */
export async function getProjectNodes(userId: number, canvasProjectId: string, toonflowProjectId?: number): Promise<CanvasNodeWithOptions[]> {
  const api = await createUserLibtvAPI(userId);
  const nodes = await api.readProjectCanvas(String(canvasProjectId).trim());
  const importedKeys = new Set<string>();
  if (toonflowProjectId) {
    const rows = await u
      .db("o_assets")
      .where("projectId", toonflowProjectId)
      .where("remark", "like", `%${SOURCE_TAG}%`)
      .select("remark");
    for (const row of rows) {
      const m = String(row.remark ?? "").match(/节点\s+([^\s·]+)/);
      if (m) importedKeys.add(m[1]);
    }
  }
  // 按类型 + 时间倒序（新的在前），画布大时免翻仓库
  const sorted = [...nodes].sort((a, b) => String(b.createTime ?? "").localeCompare(String(a.createTime ?? "")));
  return sorted.map((n) => ({ ...n, imported: importedKeys.has(n.key) }));
}

const EXT_BY_TYPE: Record<LibtvCanvasNode["type"], string> = { image: "png", video: "mp4", audio: "mp3", other: "bin" };

/** 从 URL 扩展名推断落盘扩展名，推断不出用类型缺省 */
function extFromUrl(url: string, type: LibtvCanvasNode["type"]): string {
  const m = url.split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
  if (m) return m[1].toLowerCase();
  return EXT_BY_TYPE[type] ?? "bin";
}

export interface ImportResult {
  importedCount: number;
  skippedCount: number; // 已导入过的节点数
  failed: { key: string; reason: string }[];
  assetIds: number[];
}

/** 第三步：勾选导入——下载产物 → 存 MinIO → o_assets/o_image 落库（type=clip 素材，remark 打来源标） */
export interface ImportOptions {
  /** 快创会话 id：提供时把图/视频产物同步写进快创资产白板（o_quickVideoMedia，source=upload，幂等键含画布+节点） */
  sessionId?: number;
}

export async function importNodes(userId: number, toonflowProjectId: number, canvasProjectId: string, nodeKeys: string[], options: ImportOptions = {}): Promise<ImportResult> {
  const api = await createUserLibtvAPI(userId);
  const allNodes: LibtvCanvasNode[] = await api.readProjectCanvas(String(canvasProjectId).trim());
  const byKey = new Map(allNodes.map((n) => [n.key, n]));

  // 幂等：本项目里已导入过的节点 key 直接跳过
  const existing = await u
    .db("o_assets")
    .where("projectId", toonflowProjectId)
    .where("remark", "like", `%${SOURCE_TAG}%`)
    .select("remark");
  const importedKeys = new Set<string>();
  for (const row of existing) {
    const m = String(row.remark ?? "").match(/节点\s+([^\s·]+)/);
    if (m) importedKeys.add(m[1]);
  }

  const result: ImportResult = { importedCount: 0, skippedCount: 0, failed: [], assetIds: [] };
  for (const key of nodeKeys) {
    const node = byKey.get(String(key));
    if (!node) {
      result.failed.push({ key, reason: "画布上未找到该节点（可能已被删除）" });
      continue;
    }
    if (importedKeys.has(node.key)) {
      result.skippedCount += 1;
      continue;
    }
    try {
      const assetId = await downloadAndStore(toonflowProjectId, node);
      // 快创白板桥（SIY-172 用户反馈）：把图/视频产物同步登记进 o_quickVideoMedia，
      // 资产白板立即可见、可作为参考/首帧使用；幂等键含画布+节点，重复导入自动跳过
      if (options.sessionId && (node.type === "image" || node.type === "video")) {
        try {
          const savePath = await u
            .db("o_image")
            .where("id", (await u.db("o_assets").where("id", assetId).first("imageId"))?.imageId ?? 0)
            .first("filePath")
            .then((r: any) => r?.filePath);
          if (savePath) {
            const kind = node.type === "video" ? "video" : "image";
            const { media } = await createChatMedia({
              projectId: toonflowProjectId,
              sessionId: options.sessionId,
              messageId: null,
              kind,
              model: "LibTV 导入",
              prompt: node.prompt || node.name,
              source: "upload",
              idempotencyKey: `libtv:${canvasProjectId}:${node.key}`,
            });
            if (media.state !== "done") await markChatMediaDone(media.id, savePath);
          }
        } catch (e: any) {
          // 白板登记失败不影响素材导入本身（素材库已落库）
          result.failed.push({ key: node.key, reason: `素材已导入，白板登记失败: ${String(e?.message ?? e).slice(0, 150)}` });
        }
      }
      result.assetIds.push(assetId);
      result.importedCount += 1;
      importedKeys.add(node.key);
    } catch (e: any) {
      result.failed.push({ key: node.key, reason: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return result;
}

/** 下载单个产物并存进素材库（流式直传 MinIO，不在 Node 内存里驻留完整文件——SIY-172 审查 P1-7） */
async function downloadAndStore(toonflowProjectId: number, node: LibtvCanvasNode): Promise<number> {
  const res = await axios.get(node.url, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_FILE_BYTES,
    headers: { Accept: "*/*" },
  });
  const contentType = String(res.headers["content-type"] ?? "");
  let type = node.type === "other" ? (inferTypeFromMime(contentType) ?? inferTypeFromUrl(node.url) ?? "image") : node.type;
  if (type === "other") type = "image";
  const ext = extFromUrl(node.url, type);
  const savePath = `/${toonflowProjectId}/assets/${uuid()}.${ext}`;
  // Readable 直传 MinIO（oss.writeFile 原生支持流），不再 Buffer.from(arraybuffer) 全量驻留
  const declaredSize = parseInt(String(res.headers["content-length"] ?? ""), 10);
  await u.oss.writeFile(savePath, res.data, Number.isFinite(declaredSize) ? declaredSize : undefined);

  const name = `${SOURCE_TAG} · ${node.name || node.key}`.slice(0, 100);
  const remark = `${SOURCE_TAG} · 节点 ${node.key}`.slice(0, 200);
  const [assetId] = await u.db("o_assets").insert({
    type: "clip",
    projectId: toonflowProjectId,
    name,
    remark,
    prompt: node.prompt ?? "",
    describe: node.prompt ? `导入自 LibTV 画布项目 ${node.createTime ? `（生成时间 ${node.createTime}）` : ""}`.trim() : `${SOURCE_TAG}`,
    startTime: Date.now(),
  });
  const [imageId] = await u.db("o_image").insert({
    filePath: savePath,
    type: "clip",
    assetsId: assetId,
    state: "已完成",
  });
  await u.db("o_assets").where("id", assetId).update({ imageId });
  return assetId;
}

function inferTypeFromMime(mime: string): LibtvCanvasNode["type"] | null {
  if (/^video\//i.test(mime)) return "video";
  if (/^audio\//i.test(mime)) return "audio";
  if (/^image\//i.test(mime)) return "image";
  return null;
}

function inferTypeFromUrl(url: string): LibtvCanvasNode["type"] | null {
  if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) return "video";
  if (/\.(mp3|wav|ogg|aac|flac|m4a)(\?|$)/i.test(url)) return "audio";
  if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return "image";
  return null;
}

/** 模型目录桥：`model search` 全量同步 LibTV 目录进协议目录（默认禁用，管理员按差集启用） */
export interface SyncModelsResult {
  total: number;
  added: number;
  keptCurated: number;
}

const CURATED_MODEL_KEYS = new Set(["star-video2", "nebula-ultra", "seedream-4"]);
const SYNC_FLAG = "libtvSync";

/** 解析 `libtv model search -t <type>` 输出为目录条目（输出格式未公开，走宽松 JSON 解析） */
function parseModelCatalog(stdout: string, type: "image" | "video"): { name: string; modelName: string; type: "image" | "video"; mode: string[]; [SYNC_FLAG]?: boolean }[] {
  const root = parseCliJson(stdout);
  if (!root) return [];
  const arr = Array.isArray(root) ? root : Array.isArray(root?.models) ? root.models : [];
  const out: { name: string; modelName: string; type: "image" | "video"; mode: string[]; [SYNC_FLAG]?: boolean }[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const key = item.modelKey ?? item.model_key ?? item.key;
    const name = item.modelName ?? item.display_name ?? item.displayName;
    if (typeof key !== "string" || !key.trim() || typeof name !== "string" || !name.trim()) continue;
    const isVideo = type === "video";
    out.push({
      name: `${name}（LibTV）`.slice(0, 80),
      modelName: key.trim(),
      type,
      mode: isVideo ? ["text", "singleImage"] : ["text", "singleImage", "multiReference"],
      [SYNC_FLAG]: true,
    });
  }
  return out;
}

/** 同步模型目录：合并进 o_vendorConfig.models（Curated 三模型保留原样；旧同步条目整批替换；默认不启用——enabledModels 不动） */
export async function syncModelCatalog(userId: number): Promise<SyncModelsResult> {
  const result: SyncModelsResult = { total: 0, added: 0, keptCurated: 0 };
  const synced: ReturnType<typeof parseModelCatalog> = [];
  for (const type of ["image", "video"] as const) {
    const r = await libtvBinding.runAsUser(userId, ["model", "search", "-t", type], 120000);
    if (r.code !== 0) throw new Error(`model search -t ${type} 失败:\n${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
    synced.push(...parseModelCatalog(r.stdout, type));
  }
  result.total = synced.length;

  const row = await u.db("o_vendorConfig").where("id", VENDOR_ID).first();
  const current: any[] = JSON.parse(row?.models ?? "[]");
  const curated = current.filter((m) => CURATED_MODEL_KEYS.has(m.modelName) && !m[SYNC_FLAG]);
  result.keptCurated = curated.length;
  // 去重：同步条目之间按 modelName 去重，curated 已有的 modelName 也不再重复收录
  const curatedKeys = new Set(curated.map((m) => m.modelName));
  const seen = new Set<string>();
  const mergedSynced = synced.filter((m) => {
    if (curatedKeys.has(m.modelName) || seen.has(m.modelName)) return false;
    seen.add(m.modelName);
    return true;
  });
  const next = [...curated, ...mergedSynced];
  await u.db("o_vendorConfig").where("id", VENDOR_ID).update({ models: JSON.stringify(next) });
  result.added = mergedSynced.length;
  return result;
}

export default { listUserProjects, getProjectNodes, importNodes, syncModelCatalog, assertProjectOwnership };
