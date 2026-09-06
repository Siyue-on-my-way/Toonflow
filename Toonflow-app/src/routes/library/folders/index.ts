import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

const router = express.Router();
const table = () => (u.db as any)("o_asset_folder");

export default router
  .get("/", async (req, res) => {
    const userId = Number((req as any).user?.id ?? 1);
    const folders = await table().where({ createdBy: userId }).whereNull("deletedAt").orderBy("sortOrder").orderBy("name");
    res.status(200).send(success({ data: folders }));
  })
  .post(
    "/",
    validateFields({ name: z.string().trim().min(1).max(128), parentId: z.number().int().positive().nullable().optional() }),
    async (req, res) => {
      const userId = Number((req as any).user?.id ?? 1);
      const parentId = req.body.parentId ?? null;
      if (parentId != null && !(await table().where({ id: parentId, createdBy: userId }).whereNull("deletedAt").first())) {
        return res.status(404).send({ message: "父目录不存在" });
      }
      const duplicate = await table().where({ name: req.body.name, parentId, createdBy: userId }).whereNull("deletedAt").first();
      if (duplicate) return res.status(409).send({ message: "同级目录名称已存在" });
      const [id] = await table().insert({ name: req.body.name, parentId, sortOrder: 0, createdBy: userId, createdAt: Date.now() });
      res.status(200).send(success({ id }));
    },
  );
