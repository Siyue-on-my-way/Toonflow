/**
 * QuickVideo / 单视频快创 —— 会话（session）读写层（o_quickVideoSession）
 *
 * 一个 quick_video 项目下可以有多个并行的聊天会话；每个会话独立保存标题、
 * 归档状态与文本/图片/视频模型偏好。会话之间只隔离聊天记忆与模型偏好——
 * 项目级产物（简报/分镜/生成结果，o_agentWorkData）仍是同一份，由触发写入
 * 的会话在 sessionId 字段留痕，但不按会话拆分成多份。
 */
import { db as knexDb } from "@/utils/db";
import u from "@/utils";
import { QuickVideoError } from "./state";

export interface QuickVideoSessionRow {
  id: number;
  projectId: number;
  title: string | null;
  status: string;
  textModel: string | null;
  imageModel: string | null;
  videoModel: string | null;
  createTime: number;
  updateTime: number;
}

const DEFAULT_SESSION_TITLE = "默认会话";

async function nextSessionId(trx: any): Promise<number> {
  const maxRow = await trx("o_quickVideoSession").max("id as maxId").first();
  return Number(maxRow?.maxId ?? 0) + 1;
}

/** 创建一个新会话；文本/图片/视频模型偏好从项目当前配置继承一次，之后各会话独立编辑、互不影响。 */
export async function createQuickVideoSession(projectId: number, opts: { title?: string; trx?: any } = {}): Promise<QuickVideoSessionRow> {
  const runner = opts.trx ?? knexDb;
  const project = await runner("o_project").where("id", projectId).select("textModel", "imageModel", "videoModel").first();
  const now = Date.now();
  const id = await nextSessionId(runner);
  const row: QuickVideoSessionRow = {
    id,
    projectId,
    title: opts.title?.trim() || DEFAULT_SESSION_TITLE,
    status: "active",
    textModel: project?.textModel || null,
    imageModel: project?.imageModel || null,
    videoModel: project?.videoModel || null,
    createTime: now,
    updateTime: now,
  };
  await runner("o_quickVideoSession").insert(row);
  return row;
}

/**
 * 按 updateTime 倒序列出项目下的全部会话（含归档）。一个都没有时（存量项目未迁移过）
 * 现场补建默认会话——兼容迁移在读路径上兜底，不依赖必须先跑过一次服务重启。
 */
export async function listQuickVideoSessions(projectId: number): Promise<QuickVideoSessionRow[]> {
  const rows = await u.db("o_quickVideoSession").where({ projectId }).orderBy("updateTime", "desc").select("*");
  if (rows.length) return rows as QuickVideoSessionRow[];

  const created = await ensureDefaultSession(projectId);
  return created ? [created] : [];
}

/** 存量项目补建默认会话（幂等：已存在任意会话时直接返回最新一条，不重复创建） */
export async function ensureDefaultSession(projectId: number): Promise<QuickVideoSessionRow | null> {
  const existing = await u.db("o_quickVideoSession").where({ projectId }).orderBy("updateTime", "desc").first();
  if (existing) return existing as QuickVideoSessionRow;

  return knexDb.transaction(async (trx) => {
    // 事务内二次确认，避免并发请求（如两个标签页同时打开同一存量项目）重复创建
    const raced = await trx("o_quickVideoSession").where({ projectId }).orderBy("updateTime", "desc").first();
    if (raced) return raced as QuickVideoSessionRow;
    const created = await createQuickVideoSession(projectId, { trx });
    await trx("o_agentWorkData").where({ projectId, key: "quickVideoAgent" }).update({ sessionId: created.id });
    return created;
  });
}

/** 校验 sessionId 属于 projectId；非法 id 或跨项目引用一律拒绝，不透出"其他项目是否存在该会话"的信息 */
export async function getOwnedSession(projectId: number, sessionId: number): Promise<QuickVideoSessionRow> {
  const row = await u.db("o_quickVideoSession").where({ id: sessionId }).first();
  if (!row || Number(row.projectId) !== Number(projectId)) {
    throw new QuickVideoError("SESSION_NOT_FOUND", "会话不存在或不属于当前项目");
  }
  return row as QuickVideoSessionRow;
}

/** 重命名/归档/恢复会话；任何改动都刷新 updateTime，使其重新排到列表顶部 */
export async function touchQuickVideoSession(
  projectId: number,
  sessionId: number,
  patch: { title?: string; status?: "active" | "archived" } = {},
): Promise<QuickVideoSessionRow> {
  await getOwnedSession(projectId, sessionId);
  const update: Record<string, any> = { updateTime: Date.now() };
  if (patch.title != null) update.title = patch.title.trim() || DEFAULT_SESSION_TITLE;
  if (patch.status != null) update.status = patch.status;
  await u.db("o_quickVideoSession").where({ id: sessionId }).update(update);
  return getOwnedSession(projectId, sessionId);
}

/** 仅刷新 updateTime（聊天/生成活动时调用），让活跃会话排到列表顶部；失败不影响主流程 */
export async function bumpSessionActivity(sessionId: number): Promise<void> {
  try {
    await u.db("o_quickVideoSession").where({ id: sessionId }).update({ updateTime: Date.now() });
  } catch (err) {
    console.error("[quickVideo] 更新会话活跃时间失败:", u.error(err as Error).message);
  }
}

/** 保存会话内的文本/图片/视频模型偏好（未传的字段保持不变） */
export async function saveSessionModels(
  projectId: number,
  sessionId: number,
  models: { textModel?: string; imageModel?: string; videoModel?: string },
): Promise<QuickVideoSessionRow> {
  await getOwnedSession(projectId, sessionId);
  await u.db("o_quickVideoSession").where({ id: sessionId }).update({ ...models, updateTime: Date.now() });
  return getOwnedSession(projectId, sessionId);
}
