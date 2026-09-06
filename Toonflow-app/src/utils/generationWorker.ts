import axios from "axios";
import db from "@/utils/db";
import oss from "@/utils/oss";
import error from "@/utils/error";
import { queryRunningHubTask } from "@/vendors/runninghub";
import { v4 as uuid } from "uuid";

const POLL_INTERVAL_MS = 10_000;
const LEASE_MS = 60_000;
const MAX_RECOVERY_ATTEMPTS = 8;
let running = false;

function parseRelatedObjects(value: unknown): Record<string, any> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function getRunningHubInputValues() {
  const row = await db("o_vendorConfig").where("id", "runninghub").first();
  if (!row?.inputValues) throw new Error("RunningHub 配置不存在");
  const values = JSON.parse(row.inputValues);
  const crypto = await import("@/utils/crypto");
  for (const key of Object.keys(values)) {
    if (/key|secret|token/i.test(key)) values[key] = crypto.decrypt(values[key]);
  }
  return values;
}

async function claimTask(taskId: string, now: number): Promise<boolean> {
  const updated = await db("o_generation_tasks")
    .where("taskId", taskId)
    .whereIn("status", ["CREATED", "SUBMITTED", "QUEUED", "RUNNING", "UNKNOWN"])
    .where((query) => query.whereNull("leaseUntil").orWhere("leaseUntil", "<", now))
    .update({ leaseUntil: now + LEASE_MS, updatedAt: now });
  return updated > 0;
}

async function recoverTask(task: any) {
  if (task.provider !== "runninghub" || !task.providerTaskId) return;
  const now = Date.now();
  if (!(await claimTask(task.taskId, now))) return;
  try {
    const inputValues = await getRunningHubInputValues();
    const status = await queryRunningHubTask(inputValues, task.providerTaskId);
    const polledAt = Date.now();
    if (status.status === "RUNNING") {
      await db("o_generation_tasks").where("taskId", task.taskId).update({
        status: "RUNNING", providerStatus: "RUNNING", lastPolledAt: polledAt, leaseUntil: polledAt + LEASE_MS, updatedAt: polledAt,
      });
      return;
    }
    if (status.status === "FAILED" || !status.url) {
      const reason = status.error || "RunningHub 任务成功但未返回图片 URL";
      await db("o_generation_tasks").where("taskId", task.taskId).update({ status: "FAILED", providerStatus: "FAILED", reason, lastPolledAt: polledAt, leaseUntil: null, updatedAt: polledAt });
      await db("o_storyboard").where("id", task.storyboardId).update({ state: "生成失败", reason });
      return;
    }
    const response = await axios.get(status.url, { responseType: "arraybuffer", timeout: 60_000 });
    const savePath = `/${task.projectId}/assets/${task.scriptId || "recovered"}/${uuid()}.jpg`;
    await oss.writeFile(savePath, Buffer.from(response.data));
    await db("o_storyboard").where("id", task.storyboardId).update({ filePath: savePath, state: "已完成", reason: null });
    await db("o_generation_tasks").where("taskId", task.taskId).update({ status: "SUCCEEDED", providerStatus: "SUCCESS", resultPath: savePath, lastPolledAt: polledAt, leaseUntil: null, updatedAt: Date.now() });
  } catch (e) {
    const attempts = Number(task.retryCount || 0) + 1;
    const reason = `恢复轮询失败 (${attempts}/${MAX_RECOVERY_ATTEMPTS}): ${error(e).message}`;
    const terminal = attempts >= MAX_RECOVERY_ATTEMPTS;
    await db("o_generation_tasks").where("taskId", task.taskId).update({
      retryCount: attempts, status: terminal ? "UNKNOWN" : task.status, reason, leaseUntil: terminal ? null : Date.now() + LEASE_MS, updatedAt: Date.now(),
    });
    if (terminal) await db("o_storyboard").where("id", task.storyboardId).update({ state: "生成失败", reason });
  }
}

export async function recoverGenerationTasks() {
  if (running) return;
  running = true;
  try {
    if (!(await db.schema.hasTable("o_generation_tasks"))) return;
    const tasks = await db("o_generation_tasks").whereIn("status", ["CREATED", "SUBMITTED", "QUEUED", "RUNNING", "UNKNOWN"]);
    for (const task of tasks) await recoverTask(task);
  } catch (e) {
    console.error("[生成任务恢复扫描失败]", error(e).message);
  } finally {
    running = false;
  }
}

export function startGenerationWorker() {
  void recoverGenerationTasks();
  const timer = setInterval(() => void recoverGenerationTasks(), POLL_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
