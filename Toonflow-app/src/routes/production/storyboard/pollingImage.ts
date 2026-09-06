import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { ids } = req.body;
    const data = await u.db("o_storyboard").whereIn("id", ids).select("id", "state", "reason", "filePath", "prompt");
    const taskRows = await u.db("o_generation_tasks")
      .whereIn("storyboardId", ids)
      .orderBy("updatedAt", "desc")
      .select("storyboardId", "taskId", "status as taskStatus", "providerStatus", "reason as taskReason", "lastPolledAt");
    const latestTaskByStoryboard = new Map<number, any>();
    for (const task of taskRows) {
      if (!latestTaskByStoryboard.has(task.storyboardId)) latestTaskByStoryboard.set(task.storyboardId, task);
    }
    const result = await Promise.all(
      data.map(async (item: any) => {
        const task = latestTaskByStoryboard.get(item.id);
        return {
          ...item,
          taskId: task?.taskId ?? null,
          taskStatus: task?.taskStatus ?? null,
          providerStatus: task?.providerStatus ?? null,
          taskReason: task?.taskReason ?? null,
          lastPolledAt: task?.lastPolledAt ?? null,
          reason: task?.taskReason || item.reason,
          src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : null,
        };
      }),
    );
    res.status(200).send(success(result));
  },
);
