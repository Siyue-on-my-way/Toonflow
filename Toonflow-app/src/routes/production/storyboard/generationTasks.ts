import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ taskIds: z.array(z.string()).min(1) }),
  async (req, res) => {
    const { taskIds } = req.body;
    const tasks = await u.db("o_generation_tasks").whereIn("taskId", taskIds).select(
      "taskId", "storyboardId", "projectId", "scriptId", "provider", "model", "providerTaskId",
      "status", "providerStatus", "reason", "resultPath", "createdAt", "updatedAt", "lastPolledAt", "retryCount",
    );
    const result = await Promise.all(tasks.map(async (task: any) => ({
      ...task,
      src: task.resultPath ? await u.oss.getSmallImageUrl(task.resultPath) : null,
    })));
    res.status(200).send(success(result));
  },
);
