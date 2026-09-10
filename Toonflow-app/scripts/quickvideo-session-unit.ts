/**
 * QuickVideo / 单视频快创 —— 会话隔离键 + 默认标题单元测试（SIY-128）
 * 纯函数测试，无需启动服务：
 *   npx tsx scripts/quickvideo-session-unit.ts
 *
 * 覆盖 buildSessionIsolationKey 的隔离键格式（projectId + sessionId 两个维度都必须
 * 体现在键里，不同会话/不同项目不能产出相同的键）与 buildDefaultSessionTitle 的
 * 默认标题格式（"<项目名称>-session<序号>"）。
 * 会话表的读写（listQuickVideoSessions / createQuickVideoSession / getOwnedSession /
 * bumpUserMessageCountAndMaybeClaimTitle 等）与标题生成的实际 LLM 调用都需要真实
 * MySQL/供应商配置，覆盖在 scripts/quickvideo-e2e.ts 的相关小节（需先启动服务：
 * npx tsx src/app.ts）。
 */
import { buildSessionIsolationKey, buildDefaultSessionTitle, TITLE_GENERATION_TRIGGER_COUNT } from "@/lib/quickVideo/contract";

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

console.log("== 1. 隔离键格式 ==");
{
  const k = buildSessionIsolationKey(101, 5);
  assert(k === "101:quickVideoAgent:5", "格式为 projectId:quickVideoAgent:sessionId", k);
}

console.log("== 2. 不同会话产出不同的键（同项目） ==");
{
  const k1 = buildSessionIsolationKey(101, 5);
  const k2 = buildSessionIsolationKey(101, 6);
  assert(k1 !== k2, "同项目下不同 sessionId 的隔离键不同", `${k1} vs ${k2}`);
}

console.log("== 3. 不同项目即使凑出同一个 sessionId 数字也不会撞键 ==");
{
  const k1 = buildSessionIsolationKey(101, 5);
  const k2 = buildSessionIsolationKey(102, 5);
  assert(k1 !== k2, "同 sessionId 数字下不同 projectId 的隔离键不同", `${k1} vs ${k2}`);
}

console.log("== 4. 默认标题格式：<项目名称>-session<序号> ==");
{
  assert(buildDefaultSessionTitle("夏日反转", 1) === "夏日反转-session1", "首个会话标题带序号 1");
  assert(buildDefaultSessionTitle("夏日反转", 2) === "夏日反转-session2", "第二个会话标题带序号 2，不是重复的 1");
  assert(buildDefaultSessionTitle("  夏日反转  ", 3) === "夏日反转-session3", "项目名称两端空白会被去除");
}

console.log("== 5. 项目名称缺失时退化为固定占位文案，不拼出奇怪的标题 ==");
{
  assert(buildDefaultSessionTitle(null, 1) === "默认会话", "projectName 为 null 时退化");
  assert(buildDefaultSessionTitle("   ", 1) === "默认会话", "projectName 全是空白时也退化");
}

console.log("== 6. 智能标题触发阈值：第 5 条用户消息 ==");
{
  assert(TITLE_GENERATION_TRIGGER_COUNT === 5, "阈值是 5（第 5 条消息触发，不是第 6 条）", String(TITLE_GENERATION_TRIGGER_COUNT));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
