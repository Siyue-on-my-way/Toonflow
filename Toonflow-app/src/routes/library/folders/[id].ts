import express from "express";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

const router = express.Router({ mergeParams: true });
const table = () => (u.db as any)("o_asset_folder");
const assets = () => (u.db as any)("o_library_asset");

type FolderRecord = { id: number; parentId: number | null; name: string };

export default router
  .patch(
    "/",
    validateFields({ name: z.string().trim().min(1).max(128).optional(), parentId: z.number().int().positive().nullable().optional(), sortOrder: z.number().int().optional() }),
    async (req, res) => {
      const userId = Number((req as any).user?.id ?? 1);
      const id = Number(req.params.id);
      const folder = (await table().where({ id, createdBy: userId }).whereNull("deletedAt").first()) as FolderRecord | undefined;
      if (!folder) return res.status(404).send({ message: "目录不存在" });
      const patch: Record<string, unknown> = {};
      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.sortOrder !== undefined) patch.sortOrder = req.body.sortOrder;
      if (req.body.parentId !== undefined) {
        const parentId = req.body.parentId;
        if (parentId === id) return res.status(400).send({ message: "目录不能移动到自身" });
        if (parentId != null && !(await table().where({ id: parentId, createdBy: userId }).whereNull("deletedAt").first())) return res.status(404).send({ message: "父目录不存在" });
        let current = parentId;
        while (current != null) {
          if (current === id) return res.status(400).send({ message: "目录不能移动到其子目录" });
          current = (await table().where({ id: current, createdBy: userId }).whereNull("deletedAt").first())?.parentId ?? null;
        }
        patch.parentId = parentId;
      }
      if (patch.name !== undefined || patch.parentId !== undefined) {
        const duplicate = await table().where({ createdBy: userId, name: patch.name ?? folder.name, parentId: patch.parentId ?? folder.parentId }).whereNull("deletedAt").whereNot("id", id).first();
        if (duplicate) return res.status(409).send({ message: "同级目录名称已存在" });
      }
      await table().where({ id }).update(patch);
      res.status(200).send({ message: "目录更新成功" });
    },
  )
  .delete("/", async (req, res) => {
    const userId = Number((req as any).user?.id ?? 1);
    const id = Number(req.params.id);
    const folder = await table().where({ id, createdBy: userId }).whereNull("deletedAt").first();
    if (!folder) return res.status(404).send({ message: "目录不存在" });
    const child = await table().where({ parentId: id, createdBy: userId }).whereNull("deletedAt").first();
    const asset = await assets().where({ folderId: id, createdBy: userId }).whereNull("deletedAt").first();
    if (child || asset) return res.status(409).send({ message: "目录不为空，请先移除其中内容" });
    await table().where({ id }).update({ deletedAt: Date.now() });
    res.status(200).send({ message: "目录已删除" });
  });
