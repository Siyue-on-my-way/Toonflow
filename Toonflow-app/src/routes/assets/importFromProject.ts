import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { v4 as uuid } from "uuid";

const router = express.Router();

// 跨项目引入资产（引入即复制：复制对象与记录，源项目后续删除不影响副本）
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    sourceProjectId: z.number().int().positive(),
    assetIds: z.array(z.number().int().positive()).min(1).max(100),
  }),
  async (req, res) => {
    const { projectId, sourceProjectId, assetIds } = req.body;
    const ownerId = Number((req as any).user?.id ?? 1);
    if (projectId === sourceProjectId) return res.status(400).send({ message: "目标项目与源项目相同" });
    const target = await u.db("o_project").where({ id: projectId, userId: ownerId }).first();
    if (!target) return res.status(404).send({ message: "项目不存在或无权访问" });
    const source = await u.db("o_project").where({ id: sourceProjectId, userId: ownerId }).first();
    if (!source) return res.status(404).send({ message: "源项目不存在或无权访问" });

    const sources = await u.db("o_assets").whereIn("id", assetIds).andWhere("projectId", sourceProjectId);
    const byId = new Map(sources.map((item: any) => [item.id, item]));
    const results: any[] = [];

    const copyAsset = async (sourceAsset: any, targetParentId: number | null) => {
      const image = (await u.db("o_image").where({ assetsId: sourceAsset.id }).orderBy("id", "asc")) as any[];
      const picked = image.find((item) => item.id === sourceAsset.imageId) ?? image[0];
      const srcPath = picked?.filePath;
      if (!srcPath) throw new Error("源资产没有文件");
      const ext = srcPath.slice(srcPath.lastIndexOf("."));
      const filePath = `/${projectId}/assets/${uuid()}${ext}`;
      const data = await u.oss.getFile(srcPath);
      await u.oss.writeFile(filePath, data);
      try {
        const [newId] = await u.db("o_assets").insert({
          name: sourceAsset.name,
          type: sourceAsset.type,
          describe: sourceAsset.describe,
          prompt: sourceAsset.prompt,
          projectId,
          assetsId: targetParentId,
          startTime: Date.now(),
          sourceType: "project",
          sourceAssetId: sourceAsset.id,
        });
        const [imageId] = await u.db("o_image").insert({ filePath, type: sourceAsset.type, assetsId: newId, state: "已完成" });
        await u.db("o_assets").where("id", newId).update({ imageId });
        return { id: newId, filePath };
      } catch (error) {
        try {
          await u.oss.deleteFile(filePath);
        } catch {}
        throw error;
      }
    };

    for (const assetId of assetIds) {
      const sourceAsset: any = byId.get(assetId);
      if (!sourceAsset) {
        results.push({ assetId, success: false, message: "源资产不存在" });
        continue;
      }
      try {
        const copied = await copyAsset(sourceAsset, null);
        // 音频等资产存在子资产（如多个音色变体），一并复制
        const children = await u.db("o_assets").where({ assetsId: sourceAsset.id, projectId: sourceProjectId });
        for (const child of children) {
          try {
            await copyAsset(child, copied.id);
          } catch {}
        }
        results.push({ assetId, newAssetId: copied.id, success: true });
      } catch (error) {
        results.push({ assetId, success: false, message: (error as Error).message });
      }
    }
    res.status(200).send(success({ results }));
  },
);
