import express from "express";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

const router = express.Router({ mergeParams: true });
const assets = () => (u.db as any)("o_library_asset");
const folders = () => (u.db as any)("o_asset_folder");

type LibraryAssetRecord = { id: number; filePath: string };

export default router
  .patch(
    "/",
    validateFields({ name: z.string().trim().min(1).max(255).optional(), folderId: z.number().int().positive().nullable().optional(), metadata: z.record(z.string(), z.any()).optional() }),
    async (req, res) => {
      const owner = Number((req as any).user?.id ?? 1);
      const id = Number(req.params.id);
      const asset = (await assets().where({ id, createdBy: owner }).whereNull("deletedAt").first()) as LibraryAssetRecord | undefined;
      if (!asset) return res.status(404).send({ message: "资产不存在" });
      if (req.body.folderId != null && !(await folders().where({ id: req.body.folderId, createdBy: owner }).whereNull("deletedAt").first())) return res.status(404).send({ message: "目录不存在" });
      const patch: Record<string, unknown> = {};
      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.folderId !== undefined) patch.folderId = req.body.folderId;
      if (req.body.metadata !== undefined) patch.metadata = JSON.stringify(req.body.metadata);
      await assets().where({ id }).update(patch);
      res.status(200).send({ message: "资产更新成功" });
    },
  )
  .delete("/", async (req, res) => {
    const owner = Number((req as any).user?.id ?? 1);
    const id = Number(req.params.id);
    const asset = await assets().where({ id, createdBy: owner }).whereNull("deletedAt").first();
    if (!asset) return res.status(404).send({ message: "资产不存在" });
    await assets().where({ id }).update({ deletedAt: Date.now() });
    try { await u.oss.deleteFile(asset.filePath); } catch (error) { return res.status(202).send({ message: "索引已删除，对象删除失败，请稍后重试", retryable: true }); }
    res.status(200).send({ message: "资产已删除" });
  });
