/**
 * QuickVideo / 单视频快创 —— 聊天确认类工具门内核单元测试（SIY-152）
 * 纯函数测试，无需启动服务：
 *   yarn test:quickvideo-confirm-gate
 *
 * 覆盖 Agent 确认类工具（confirm_brief / reject_brief / confirm_storyboard / reject_storyboard /
 * retry_shot）复用的 lib 门内核（contract.ts）：
 * 1. 乐观锁：assertExpectedVersion 版本冲突拦截（错误码/文案/当前版本回带），版本一致或未传时放行；
 * 2. gate=brief 阶段白名单：confirm/reject 在各阶段的放行与拦截、错误文案与 REST confirmStage
 *    逐字一致、被拦截时状态零副作用；
 * 3. gate=storyboard 阶段白名单：confirm/reject 的放行与拦截、reject 的阶段回退流转、零副作用；
 * 4. retry_shot 目标解析：非生成阶段拦截（文案与 retryQuickVideoShots 一致）、显式 shotIds 原样
 *    透传、缺省取全部失败镜头（与前端 isShotFailed 同口径）、无失败镜头时 NO_FAILED_SHOTS；
 * 5. 幂等命中：工具幂等键（tool:<toolName>:<toolCallId>）经 recordIdempotencyKey 的首次写入与
 *    重放去重语义（mutateQuickVideoState 的权威记账使用的同一纯函数）、appliedKeys 容量淘汰。
 *
 * 说明：mutateQuickVideoState 的事务/行锁/真实幂等返回需要 MySQL，属于 DB 链路行为，
 * 与 REST 按钮链路共用同一实现，不在纯函数测试范围内。
 */
import {
  IDEMPOTENCY_MAX_KEYS,
  QuickVideoError,
  QuickVideoState,
  applyBriefGate,
  applyStoryboardGateReject,
  assertBriefGate,
  assertExpectedVersion,
  assertRetryShotStage,
  assertStoryboardGate,
  isShotFailed,
  pickFailedShotIds,
  pickRetryShotIds,
  quickVideoStateSchema,
  recordIdempotencyKey,
} from "@/lib/quickVideo/contract";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

function expectError(fn: () => void, code: string, messageIncludes?: string): { ok: boolean; err?: QuickVideoError } {
  try {
    fn();
    return { ok: false };
  } catch (err: any) {
    const isQv = err instanceof QuickVideoError;
    const codeOk = isQv && err.code === code;
    const msgOk = messageIncludes == null || (isQv && err.message.includes(messageIncludes));
    return { ok: isQv && codeOk && msgOk, err: isQv ? err : undefined };
  }
}

function makeBrief(confirmed = false) {
  return {
    theme: "夏日小猫",
    hook: "小猫追蝴蝶",
    narrative: "花园里小猫追蝴蝶，最后安静睡去",
    cta: "关注看更多",
    keywords: ["治愈"],
    confirmed,
    confirmedAt: confirmed ? 1 : null,
  };
}

function makeShot(id: string, index: number, imageState: any, videoState: any) {
  return {
    id,
    index,
    duration: 6,
    description: `镜头${index}`,
    dialogue: "",
    camera: "",
    assetRefs: [],
    imagePrompt: "一只小猫",
    videoPrompt: "小猫奔跑",
    continuity: "last_frame" as const,
    imageState,
    videoState,
    imageRef: null,
    videoRef: null,
    errorReason: null,
    firstFrame: null,
  };
}

function makeState(overrides: Record<string, any> = {}): QuickVideoState {
  return quickVideoStateSchema.parse({
    version: 1,
    stage: "collect_brief",
    targetDuration: 30,
    videoRatio: "16:9",
    artStyle: "水彩",
    configVersion: 0,
    createIdempotencyKey: "idem-key-0152",
    brief: makeBrief(),
    storyboard: null,
    appliedKeys: {},
    lastChatAt: null,
    updateTime: Date.now(),
    ...overrides,
  });
}

/** 深拷贝快照，用于校验被拦截调用零副作用 */
function snapshot(state: QuickVideoState): string {
  return JSON.stringify(state);
}

console.log("== 1. 乐观锁：assertExpectedVersion 版本冲突拦截 ==");
{
  assertExpectedVersion(5, 5);
  assertExpectedVersion(5, null);
  assertExpectedVersion(5, undefined);
  assert(true, "版本一致 / 未传 expectedVersion 放行");

  const r = expectError(() => assertExpectedVersion(7, 5), "VERSION_CONFLICT", "状态版本冲突");
  assert(r.ok, "版本不一致抛 VERSION_CONFLICT 且文案完整", JSON.stringify(r.err?.message));
  assert(r.err?.currentVersion === 7, "错误回带服务端当前版本 currentVersion=7", String(r.err?.currentVersion));
}

console.log("== 2. gate=brief 阶段白名单（confirm） ==");
{
  for (const stage of ["collect_brief", "storyboard_draft", "brief_confirmed"]) {
    const state = makeState({ stage });
    assert(expectError(() => assertBriefGate(state, "confirm"), "STAGE_MISMATCH").ok === false, `阶段 ${stage} 允许确认简报`);
  }
  for (const stage of ["storyboard_confirmed", "generating", "ready_to_assemble", "completed"]) {
    const state = makeState({ stage });
    const r = expectError(() => assertBriefGate(state, "confirm"), "STAGE_MISMATCH", "不允许确认简报");
    assert(r.ok, `阶段 ${stage} 确认简报被拦截（与按钮同文案）`, JSON.stringify(r.err?.message));
  }
  // 错误阶段调用零副作用
  const blocked = makeState({ stage: "generating" });
  const before = snapshot(blocked);
  expectError(() => applyBriefGate(blocked, "confirm"), "STAGE_MISMATCH");
  assert(snapshot(blocked) === before, "被拦截的确认简报零副作用（stage 与简报状态不变）");

  // 无简报拦截
  const noBrief = makeState({ stage: "collect_brief", brief: null });
  const r = expectError(() => assertBriefGate(noBrief, "confirm"), "NO_BRIEF", "暂无简报");
  assert(r.ok, "无简报时确认被拦截 NO_BRIEF", JSON.stringify(r.err?.message));
}

console.log("== 3. gate=brief 流转（confirm / reject） ==");
{
  const a = makeState({ stage: "collect_brief", brief: makeBrief(false) });
  applyBriefGate(a, "confirm");
  assert(a.stage === "brief_confirmed" && a.brief!.confirmed === true && (a.brief!.confirmedAt ?? 0) > 0, "collect_brief 确认后进入 brief_confirmed");

  const b = makeState({ stage: "storyboard_draft", brief: makeBrief(true) });
  applyBriefGate(b, "confirm");
  assert(b.stage === "brief_confirmed", "storyboard_draft 重复确认回到 brief_confirmed（与按钮同口径）");

  const c = makeState({ stage: "brief_confirmed", brief: makeBrief(true) });
  applyBriefGate(c, "confirm");
  assert(c.stage === "brief_confirmed" && c.brief!.confirmed === true, "brief_confirmed 重复确认停留原地（幂等）");

  const d = makeState({ stage: "brief_confirmed", brief: makeBrief(true) });
  applyBriefGate(d, "reject");
  assert(d.stage === "collect_brief" && d.brief!.confirmed === false && d.brief!.confirmedAt === null, "reject 后回到 collect_brief 且确认状态清除");

  const e = makeState({ stage: "collect_brief", brief: makeBrief(false) });
  applyBriefGate(e, "reject");
  assert(e.stage === "collect_brief" && e.brief!.confirmed === false, "collect_brief 阶段 reject 停留原地（幂等）");
}

console.log("== 4. gate=brief 阶段白名单（reject） ==");
{
  for (const stage of ["storyboard_draft", "storyboard_confirmed", "generating", "ready_to_assemble", "completed"]) {
    const state = makeState({ stage });
    const r = expectError(() => assertBriefGate(state, "reject"), "STAGE_MISMATCH", "简报已进入后续流程");
    assert(r.ok, `阶段 ${stage} 退回简报被拦截（与按钮同文案）`, JSON.stringify(r.err?.message));
  }
  const blocked = makeState({ stage: "storyboard_draft", storyboard: { version: 1, status: "draft", confirmedAt: null, summary: "", shots: [makeShot("shot-1", 1, "pending", "pending")] } });
  const before = snapshot(blocked);
  expectError(() => applyBriefGate(blocked, "reject"), "STAGE_MISMATCH");
  assert(snapshot(blocked) === before, "被拦截的退回简报零副作用（分镜不受影响）");
}

console.log("== 5. gate=storyboard 阶段白名单（confirm / reject） ==");
{
  const storyboard = (status: "draft" | "confirmed") => ({
    version: 1,
    status,
    confirmedAt: status === "confirmed" ? 1 : null,
    summary: "测试",
    shots: [makeShot("shot-1", 1, "pending", "pending")],
  });

  const draft = makeState({ stage: "storyboard_draft", storyboard: storyboard("draft") });
  assert(expectError(() => assertStoryboardGate(draft, "confirm"), "STAGE_MISMATCH").ok === false, "storyboard_draft 允许确认分镜");

  for (const stage of ["collect_brief", "brief_confirmed", "storyboard_confirmed", "generating", "ready_to_assemble", "completed"]) {
    const state = makeState({ stage, storyboard: storyboard(stage === "storyboard_confirmed" ? "confirmed" : "draft") });
    const r = expectError(() => assertStoryboardGate(state, "confirm"), "STAGE_MISMATCH", "不允许确认分镜");
    assert(r.ok, `阶段 ${stage} 确认分镜被拦截（与按钮同文案）`, JSON.stringify(r.err?.message));
  }

  const confirmed = makeState({ stage: "storyboard_confirmed", storyboard: storyboard("confirmed") });
  assert(expectError(() => assertStoryboardGate(confirmed, "reject"), "STAGE_MISMATCH").ok === false, "storyboard_confirmed 允许撤销确认");

  for (const stage of ["collect_brief", "brief_confirmed", "storyboard_draft", "generating", "ready_to_assemble", "completed"]) {
    const state = makeState({ stage, storyboard: storyboard("draft") });
    const r = expectError(() => assertStoryboardGate(state, "reject"), "STAGE_MISMATCH", "不需要撤销分镜确认");
    assert(r.ok, `阶段 ${stage} 撤销分镜确认被拦截（与按钮同文案）`, JSON.stringify(r.err?.message));
  }

  const noStoryboard = makeState({ stage: "storyboard_draft", storyboard: null });
  assert(expectError(() => assertStoryboardGate(noStoryboard, "confirm"), "NO_STORYBOARD", "暂无分镜").ok, "无分镜时确认被拦截 NO_STORYBOARD");

  // 拦截零副作用
  const blocked = makeState({ stage: "generating", storyboard: storyboard("draft") });
  const before = snapshot(blocked);
  expectError(() => assertStoryboardGate(blocked, "confirm"), "STAGE_MISMATCH");
  expectError(() => assertStoryboardGate(blocked, "reject"), "STAGE_MISMATCH");
  assert(snapshot(blocked) === before, "被拦截的分镜确认/撤销零副作用");
}

console.log("== 6. gate=storyboard reject 流转 ==");
{
  const s = makeState({
    stage: "storyboard_confirmed",
    storyboard: { version: 3, status: "confirmed", confirmedAt: 123, summary: "v3", shots: [makeShot("shot-1", 1, "pending", "pending")] },
  });
  applyStoryboardGateReject(s);
  assert(s.stage === "storyboard_draft" && s.storyboard!.status === "draft" && s.storyboard!.confirmedAt === null, "撤销确认后回到 storyboard_draft 解锁编辑");
}

console.log("== 7. retry_shot：阶段拦截与目标解析 ==");
{
  for (const stage of ["collect_brief", "brief_confirmed", "storyboard_draft", "storyboard_confirmed", "ready_to_assemble", "completed"]) {
    const state = makeState({ stage });
    const r = expectError(() => assertRetryShotStage(state), "STAGE_MISMATCH", "仅生成阶段可重试失败镜头");
    assert(r.ok, `阶段 ${stage} 重试被拦截（与 retryShot 按钮同文案）`, JSON.stringify(r.err?.message));
    const r2 = expectError(() => pickRetryShotIds(state), "STAGE_MISMATCH");
    assert(r2.ok, `阶段 ${stage} pickRetryShotIds 同样拦截`);
  }
  const okState = makeState({ stage: "generating" });
  assert(expectError(() => assertRetryShotStage(okState), "STAGE_MISMATCH").ok === false, "generating 阶段允许重试");
}

console.log("== 8. retry_shot：显式 shotIds 透传与缺省全失败 ==");
{
  const shots = [
    makeShot("shot-1", 1, "failed", "pending"), // 失败（图失败）
    makeShot("shot-2", 2, "done", "done"), // 完成
    makeShot("shot-3", 3, "done", "failed"), // 失败（视频失败）
    makeShot("shot-4", 4, "pending", "pending"), // 未失败
  ];
  const state = makeState({ stage: "generating", storyboard: { version: 1, status: "confirmed", confirmedAt: 1, summary: "", shots } });

  assert(pickRetryShotIds(state, ["shot-2"]).join(",") === "shot-2", "显式 shotIds 原样透传（存在性/已完成校验由 retryQuickVideoShots 权威执行）");

  assert(isShotFailed(shots[0]) && !isShotFailed(shots[1]) && isShotFailed(shots[2]) && !isShotFailed(shots[3]), "isShotFailed 与前端同口径（任一产物 failed 即失败）");

  const failed = pickFailedShotIds(state);
  assert(failed.join(",") === "shot-1,shot-3", "缺省重试目标=全部失败镜头且按播放顺序", failed.join(","));

  const picked = pickRetryShotIds(state);
  assert(picked.join(",") === "shot-1,shot-3", "pickRetryShotIds 不传 shotIds 时取全部失败镜头", picked.join(","));

  const allDone = makeState({
    stage: "generating",
    storyboard: { version: 1, status: "confirmed", confirmedAt: 1, summary: "", shots: [makeShot("shot-1", 1, "done", "done")] },
  });
  const r = expectError(() => pickRetryShotIds(allDone), "NO_FAILED_SHOTS", "当前没有失败镜头");
  assert(r.ok, "无失败镜头时 NO_FAILED_SHOTS", JSON.stringify(r.err?.message));

  const noStoryboard = makeState({ stage: "generating", storyboard: null });
  assert(pickFailedShotIds(noStoryboard).length === 0, "无分镜时失败镜头列表为空");
}

console.log("== 9. 幂等命中：工具幂等键记账（recordIdempotencyKey） ==");
{
  // 模拟 confirm_brief 工具调用序：首次执行 vs 同 toolCallId 重放
  const state = makeState({ stage: "collect_brief", brief: makeBrief(false) });
  const key = "tool:confirm_brief:call-abc-123";
  assert(state.appliedKeys[key] == null, "重放预检：未执行过时 appliedKeys 无该键");

  const first = recordIdempotencyKey(state, key);
  assert(first === true, "首次调用记录幂等键成功");
  assert(state.appliedKeys[key] != null, "appliedKeys 已含工具幂等键");

  applyBriefGate(state, "confirm");
  state.version += 1; // 模拟 mutateQuickVideoState 的版本自增
  const afterFirstVersion = state.version;

  const replay = recordIdempotencyKey(state, key);
  assert(replay === false, "同 toolCallId 重放被幂等去重（mutate 将返回 idempotentHit）");
  // 重放命中时调用方跳过内核执行，状态不再变化
  assert(state.version === afterFirstVersion && state.stage === "brief_confirmed", "重放命中后状态不再变化（无副作用）");

  // 不同 toolCallId 的新调用不受影响
  assert(recordIdempotencyKey(state, "tool:confirm_brief:call-next-456") === true, "新 toolCallId 正常写入");

  // 容量淘汰：超过上限后最早的键被淘汰
  const big = makeState({ stage: "generating" });
  for (let i = 0; i < IDEMPOTENCY_MAX_KEYS + 5; i++) {
    recordIdempotencyKey(big, `tool:retry_shot:call-${i}`);
  }
  assert(Object.keys(big.appliedKeys).length === IDEMPOTENCY_MAX_KEYS, `appliedKeys 容量封顶 ${IDEMPOTENCY_MAX_KEYS}`);
  assert(big.appliedKeys["tool:retry_shot:call-0"] == null, "最早的幂等键被淘汰");
  assert(big.appliedKeys[`tool:retry_shot:call-${IDEMPOTENCY_MAX_KEYS + 4}`] != null, "最新的幂等键保留");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
