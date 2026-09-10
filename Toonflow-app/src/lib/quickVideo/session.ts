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
import { buildSessionIsolationKey, buildDefaultSessionTitle, TITLE_GENERATION_TRIGGER_COUNT } from "./contract";

export type QuickVideoSessionTitleStatus = "idle" | "running" | "done" | "failed";

export interface QuickVideoSessionRow {
  id: number;
  projectId: number;
  title: string | null;
  status: string;
  textModel: string | null;
  imageModel: string | null;
  videoModel: string | null;
  sequence: number | null;
  userMessageCount: number | null;
  titleStatus: QuickVideoSessionTitleStatus | null;
  titleGeneratedAt: number | null;
  createTime: number;
  updateTime: number;
}

async function nextSessionId(trx: any): Promise<number> {
  const maxRow = await trx("o_quickVideoSession").max("id as maxId").first();
  return Number(maxRow?.maxId ?? 0) + 1;
}

/** 项目内下一个会话序号：归档/删除的会话仍占用过的序号不会被复用（永远取历史最大值 + 1） */
async function nextSessionSequence(trx: any, projectId: number): Promise<number> {
  const maxRow = await trx("o_quickVideoSession").where({ projectId }).max("sequence as maxSequence").first();
  return Number(maxRow?.maxSequence ?? 0) + 1;
}

/** 创建一个新会话；文本/图片/视频模型偏好从项目当前配置继承一次，之后各会话独立编辑、互不影响。 */
export async function createQuickVideoSession(projectId: number, opts: { title?: string; trx?: any } = {}): Promise<QuickVideoSessionRow> {
  const runner = opts.trx ?? knexDb;
  const project = await runner("o_project").where("id", projectId).select("name", "textModel", "imageModel", "videoModel").first();
  const now = Date.now();
  const id = await nextSessionId(runner);
  const sequence = await nextSessionSequence(runner, projectId);
  const row: QuickVideoSessionRow = {
    id,
    projectId,
    title: opts.title?.trim() || buildDefaultSessionTitle(project?.name, sequence),
    status: "active",
    textModel: project?.textModel || null,
    imageModel: project?.imageModel || null,
    videoModel: project?.videoModel || null,
    sequence,
    userMessageCount: 0,
    titleStatus: "idle",
    titleGeneratedAt: null,
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

/**
 * 存量项目补建默认会话（幂等：已存在任意会话时直接返回最新一条，不重复创建）。
 * 同一事务内把该项目在旧版单一隔离键（projectId:quickVideoAgent，无 sessionId 段）下的
 * 聊天记忆整体迁移到新会话的隔离键上——否则老项目迁移后 getMemory 会按新的
 * projectId:quickVideoAgent:sessionId 查询，查到空列表，表现为"历史记录丢了"。
 */
export async function ensureDefaultSession(projectId: number): Promise<QuickVideoSessionRow | null> {
  const existing = await u.db("o_quickVideoSession").where({ projectId }).orderBy("updateTime", "desc").first();
  if (existing) return existing as QuickVideoSessionRow;

  return knexDb.transaction(async (trx) => {
    // 事务内二次确认，避免并发请求（如两个标签页同时打开同一存量项目）重复创建
    const raced = await trx("o_quickVideoSession").where({ projectId }).orderBy("updateTime", "desc").first();
    if (raced) return raced as QuickVideoSessionRow;
    const created = await createQuickVideoSession(projectId, { trx });
    await trx("o_agentWorkData").where({ projectId, key: "quickVideoAgent" }).update({ sessionId: created.id });
    await trx("memories")
      .where({ isolationKey: `${projectId}:quickVideoAgent` })
      .update({ isolationKey: buildSessionIsolationKey(projectId, created.id) });
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
  const trimmedTitle = patch.title?.trim();
  if (trimmedTitle) update.title = trimmedTitle; // 提交空白标题视为不改名，而不是回填占位文案
  if (patch.status != null) update.status = patch.status;
  await u.db("o_quickVideoSession").where({ id: sessionId }).update(update);
  return getOwnedSession(projectId, sessionId);
}

/**
 * 每条用户聊天消息调用一次：原子地把 userMessageCount + 1，并在计数刚好达到
 * TITLE_GENERATION_TRIGGER_COUNT 且当前是 idle 状态时，把标题生成状态抢占为
 * running（同一事务内完成，天然避免并发消息重复抢占）。同时顺带刷新 updateTime，
 * 让活跃会话排到列表顶部，不必再单独调一次。
 * 返回 true 表示这次调用抢到了生成资格，调用方应在聊天轮次结束后触发一次标题生成。
 */
export async function bumpUserMessageCountAndMaybeClaimTitle(sessionId: number): Promise<boolean> {
  try {
    return await knexDb.transaction(async (trx) => {
      const row = await trx("o_quickVideoSession").where({ id: sessionId }).forUpdate().first();
      if (!row) return false;
      const nextCount = Number(row.userMessageCount ?? 0) + 1;
      const update: Record<string, any> = { userMessageCount: nextCount, updateTime: Date.now() };
      const shouldClaim = nextCount === TITLE_GENERATION_TRIGGER_COUNT && row.titleStatus === "idle";
      if (shouldClaim) {
        update.titleStatus = "running";
        update.titleGenerationClaimedAt = Date.now();
      }
      await trx("o_quickVideoSession").where({ id: sessionId }).update(update);
      return shouldClaim;
    });
  } catch (err) {
    console.error("[quickVideo] 更新会话发言计数失败:", u.error(err as Error).message);
    return false;
  }
}

/** 标题生成结束后回写：成功写入新标题并置为 done；失败保留原标题，置为 failed（不重试，也不影响聊天） */
export async function finishTitleGeneration(sessionId: number, result: { title: string } | { error: string }): Promise<void> {
  try {
    if ("title" in result) {
      await u.db("o_quickVideoSession").where({ id: sessionId }).update({ title: result.title, titleStatus: "done", titleGeneratedAt: Date.now() });
    } else {
      await u.db("o_quickVideoSession").where({ id: sessionId }).update({ titleStatus: "failed" });
      console.error(`[quickVideo] 会话 ${sessionId} 智能标题生成失败:`, result.error);
    }
  } catch (err) {
    console.error("[quickVideo] 回写会话标题状态失败:", u.error(err as Error).message);
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
