/**
 * QuickVideo / 单视频快创 —— 会话隔离键单元测试（SIY-128）
 * 纯函数测试，无需启动服务：
 *   npx tsx scripts/quickvideo-session-unit.ts
 *
 * 覆盖 buildSessionIsolationKey 的隔离键格式（projectId + sessionId 两个维度都必须
 * 体现在键里，不同会话/不同项目不能产出相同的键）。
 * 会话表的读写（listQuickVideoSessions / createQuickVideoSession / getOwnedSession 等）
 * 需要真实 MySQL，覆盖在 scripts/quickvideo-e2e.ts 的「13. Session 会话隔离」一节
 * （需先启动服务：npx tsx src/app.ts）。
 */
import { buildSessionIsolationKey } from "@/lib/quickVideo/contract";

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

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
