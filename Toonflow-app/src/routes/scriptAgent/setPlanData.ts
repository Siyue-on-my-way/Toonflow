import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent"]),
    data: z.object({
      storySkeleton: z.string(),
      adaptationStrategy: z.string(),
      script: z
        .array(z.object({ name: z.string(), content: z.string() }))
        .optional(),
    }),
  }),
  async (req, res) => {
    const { projectId, agentType, data } = req.body;
    await u
      .db("o_agentWorkData")
      .where({ projectId: projectId, key: agentType })
      .update({
        data: JSON.stringify(data),
      });
    const script = data.script || [];

    // o_script.id 无自增（integer + primary，非 increments），需手动取 max(id)+1，
    // 与 addScript 路由保持一致；否则 strict 模式下 ER_NO_DEFAULT_FOR_FIELD。
    const maxRow = await u.db("o_script").max("id as maxId").first();
    let nextId = Number(maxRow?.maxId ?? 0) + 1;
    for (const s of script) {
      const row = await u.db("o_script").where({ projectId, name: s.name }).first();
      if (row) {
        await u.db("o_script").where({ id: row.id }).update({ content: s.content });
      } else {
        await u.db("o_script").insert({
          id: nextId++,
          projectId,
          name: s.name,
          content: s.content,
          createTime: Date.now(),
        });
      }
    }

    res.status(200).send(success());
  },
);
