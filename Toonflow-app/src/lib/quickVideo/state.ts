/**
 * QuickVideo 状态读写层（o_agentWorkData.key = "quickVideoAgent"）
 *
 * 所有写入统一走 mutateQuickVideoState：
 * - 事务内「读 -> 校验乐观锁 -> 校验阶段转移 -> 应用变更 -> zod 校验 -> 版本自增 -> 写回」
 * - 幂等键去重：同一 key 的写入只应用一次，重复请求返回首次结果
 * - 阶段转移必须命中 STAGE_TRANSITIONS 白名单，否则拒绝
 */
import { db as knexDb } from "@/utils/db";
import u from "@/utils";
import {
  QUICK_VIDEO_AGENT_KEY,
  QUICK_VIDEO_SCHEMA_VERSION,
  QUICK_VIDEO_STAGES,
  QuickVideoStage,
  QuickVideoState,
  canTransitionStage,
  quickVideoStateSchema,
  recordIdempotencyKey,
} from "./contract";

export class QuickVideoError extends Error {
  public code: string;
  public currentVersion?: number;

  constructor(code: string, message: string, currentVersion?: number) {
    super(message);
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

function parseState(row: { data?: string | null }): QuickVideoState {
  let raw: any = {};
  try {
    raw = JSON.parse(row.data ?? "{}");
  } catch {
    throw new QuickVideoError("STATE_CORRUPTED", "quickVideoAgent 状态数据损坏，无法解析");
  }
  const parsed = quickVideoStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new QuickVideoError("STATE_INVALID", `quickVideoAgent 状态数据不满足契约：${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}

export async function getQuickVideoStateRow(projectId: number) {
  return u.db("o_agentWorkData").where({ projectId: String(projectId), key: QUICK_VIDEO_AGENT_KEY }).first();
}

/** 读取当前状态（不存在时返回 null） */
export async function loadQuickVideoState(projectId: number): Promise<QuickVideoState | null> {
  const row = await getQuickVideoStateRow(projectId);
  return row ? parseState(row) : null;
}

export interface MutateOptions {
  /** 乐观锁：调用方持有的版本号；与服务端不一致时拒绝写入 */
  expectedVersion?: number;
  /** 幂等键：重复提交直接返回首次结果 */
  idempotencyKey?: string;
  /** 本次写入涉及的阶段转移（source -> target），必须在白名单内 */
  stageTransition?: { from: QuickVideoStage; to: QuickVideoStage };
  /** 触发本次写入的会话（留痕用，不影响状态内容与校验；未提供时保留上次记录的值） */
  sessionId?: number;
}

export interface MutateResult {
  state: QuickVideoState;
  /** true 表示本次为幂等去重命中，未发生实际写入 */
  idempotentHit: boolean;
}

/**
 * 事务化状态变更入口。mutator 内拿到深拷贝后的当前状态与事务句柄，就地修改状态并返回；
 * 返回前统一做契约校验、版本自增与幂等记录。需要同步落其他表时（如 o_project）使用 trx，保证原子性。
 */
export async function mutateQuickVideoState(
  projectId: number,
  opts: MutateOptions,
  mutator: (state: QuickVideoState, trx: any) => void | Promise<void>,
): Promise<MutateResult> {
  // u.db 是 Object.assign 出来的代理，原型上的 transaction 不在其上，这里用原始 knex 实例
  return knexDb.transaction(async (trx) => {
    // 生成链路会并发回写多个镜头。必须锁住状态行，让每次变更都基于
    // 上一次完整 JSON 结果合并，否则两个事务可能同时读取同一版本，
    // 后提交者会把先完成镜头的状态覆盖回 pending。
    const row = await trx("o_agentWorkData")
      .where({ projectId: String(projectId), key: QUICK_VIDEO_AGENT_KEY })
      .forUpdate()
      .first();
    if (!row) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态，请先创建 quick_video 项目");

    const current = parseState(row);

    // 幂等去重：已应用过的 key 直接返回当前状态，不再变更
    if (opts.idempotencyKey && current.appliedKeys[opts.idempotencyKey] != null) {
      return { state: current, idempotentHit: true };
    }

    // 乐观锁校验
    if (opts.expectedVersion != null && opts.expectedVersion !== current.version) {
      throw new QuickVideoError(
        "VERSION_CONFLICT",
        `状态版本冲突：服务端当前版本 ${current.version}，请求基于版本 ${opts.expectedVersion}，请刷新后重试`,
        current.version,
      );
    }

    const state: QuickVideoState = JSON.parse(JSON.stringify(current));

    if (opts.stageTransition) {
      const { from, to } = opts.stageTransition;
      if (state.stage !== from) {
        throw new QuickVideoError("STAGE_MISMATCH", `阶段不符：当前处于 ${state.stage}，该操作要求 ${from}`, state.version);
      }
      if (!canTransitionStage(from, to)) {
        throw new QuickVideoError("STAGE_FORBIDDEN", `不允许的阶段转移：${from} -> ${to}`, state.version);
      }
    }

    await mutator(state, trx);

    // 阶段合法性兜底：mutator 直接改 stage 也必须命中白名单
    if (state.stage !== current.stage && !canTransitionStage(current.stage, state.stage)) {
      throw new QuickVideoError("STAGE_FORBIDDEN", `不允许的阶段转移：${current.stage} -> ${state.stage}`, current.version);
    }
    if (!QUICK_VIDEO_STAGES.includes(state.stage)) {
      throw new QuickVideoError("STAGE_INVALID", `未知阶段：${state.stage}`, current.version);
    }

    // 幂等键记录（未提供 key 时跳过记录，行为与旧接口兼容）
    if (opts.idempotencyKey && !recordIdempotencyKey(state, opts.idempotencyKey)) {
      return { state: current, idempotentHit: true };
    }

    // 契约校验 + 版本自增
    state.schemaVersion = QUICK_VIDEO_SCHEMA_VERSION;
    state.updateTime = Date.now();
    state.version = current.version + 1;
    const parsed = quickVideoStateSchema.safeParse(state);
    if (!parsed.success) {
      throw new QuickVideoError(
        "STATE_INVALID",
        `写入被拒绝，状态不满足契约：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        current.version,
      );
    }

    await trx("o_agentWorkData")
      .where({ id: row.id })
      .update({
        data: JSON.stringify(parsed.data),
        updateTime: Date.now(),
        ...(opts.sessionId != null ? { sessionId: opts.sessionId } : {}),
      });

    return { state: parsed.data, idempotentHit: false };
  });
}

/**
 * 按创建幂等键查找已创建的 quick_video 项目（有界扫描最近记录）。
 * createProject 防重复建项目用：幂等键为 uuid，LIKE 误判概率可忽略。
 */
export async function findProjectByCreateIdempotencyKey(idempotencyKey: string): Promise<number | null> {
  if (!idempotencyKey) return null;
  const rows = await u
    .db("o_agentWorkData")
    .where("key", QUICK_VIDEO_AGENT_KEY)
    .andWhere("data", "like", `%${idempotencyKey}%`)
    .orderBy("id", "desc")
    .limit(20)
    .select("projectId", "data");
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data ?? "{}");
      if (data?.createIdempotencyKey === idempotencyKey && Number(row.projectId)) {
        return Number(row.projectId);
      }
    } catch {
      // 跳过解析失败的行
    }
  }
  return null;
}

/** 初始化 quickVideoAgent 状态行（createProject 事务内调用）。
 * 画风/目标时长允许缺省（SIY-138 对话式配置）：后续在聊天中用 update_config 设置。 */
export async function initQuickVideoStateRow(
  trx: any,
  { projectId, idempotencyKey, targetDuration, videoRatio, artStyle }: { projectId: number; idempotencyKey: string; targetDuration?: number | null; videoRatio: string; artStyle?: string },
) {
  const now = Date.now();
  const state = quickVideoStateSchema.parse({
    version: 1,
    stage: "collect_brief",
    targetDuration: targetDuration ?? null,
    videoRatio,
    artStyle: artStyle ?? "",
    configVersion: 0,
    pendingSnapshot: null,
    confirmationStatus: "none",
    createIdempotencyKey: idempotencyKey,
    brief: null,
    storyboard: null,
    appliedKeys: {},
    lastChatAt: null,
    updateTime: now,
  } as any);
  const maxRow = await trx("o_agentWorkData").max("id as maxId").first();
  const id = Number(maxRow?.maxId ?? 0) + 1;
  await trx("o_agentWorkData").insert({
    id,
    projectId,
    key: QUICK_VIDEO_AGENT_KEY,
    data: JSON.stringify(state),
    createTime: now,
    updateTime: now,
  });
  return state;
}
