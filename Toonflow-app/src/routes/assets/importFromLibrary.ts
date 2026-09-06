import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { v4 as uuid } from "uuid";

const router = express.Router();
const compatible: Record<string, string[]> = { role: ["role", "image"], tool: ["tool", "image"], scene: ["scene", "image"], audio: ["audio"], video: ["video", "clip"], clip: ["video", "clip"] };

export default router.post(
  "/",
  validateFields({ projectId: z.number().int().positive(), libraryAssetIds: z.array(z.number().int().positive()).min(1).max(100), type: z.string() }),
  async (req, res) => {
    const { projectId, libraryAssetIds, type } = req.body;
    const ownerId = Number((req as any).user?.id ?? 1);
    if (!compatible[type]?.length) return res.status(400).send({ message: "不支持的资产类型" });
    const project = await u.db("o_project").where({ id: projectId, userId: ownerId }).first();
    if (!project) return res.status(404).send({ message: "项目不存在或无权访问" });
    const sources = await u.db("o_library_asset").whereIn("id", libraryAssetIds).where({ createdBy: ownerId }).whereNull("deletedAt");
    const byId = new Map(sources.map((source: any) => [source.id, source]));
    const results: any[] = [];
    for (const sourceId of libraryAssetIds) {
      const source: any = byId.get(sourceId);
      if (!source) { results.push({ libraryAssetId: sourceId, success: false, message: "源资产不存在" }); continue; }
      if (!compatible[type].includes(source.type)) { results.push({ libraryAssetId: sourceId, success: false, message: "资产类型不匹配" }); continue; }
      let filePath = `/${projectId}/assets/${uuid()}${source.filePath.slice(source.filePath.lastIndexOf("."))}`;
      try {
        const data = await u.oss.getFile(source.filePath);
        await u.oss.writeFile(filePath, data);
        const [assetId] = await u.db("o_assets").insert({ name: source.name, type, projectId, startTime: Date.now(), sourceType: "library", sourceAssetId: source.id });
        const [imageId] = await u.db("o_image").insert({ filePath, type, assetsId: assetId, state: "已完成" });
        await u.db("o_assets").where("id", assetId).update({ imageId });
        results.push({ libraryAssetId: source.id, assetId, success: true });
      } catch (error) {
        try { await u.oss.deleteFile(filePath); } catch {}
        results.push({ libraryAssetId: source.id, success: false, message: (error as Error).message });
      }
    }
    res.status(200).send(success({ results }));
  },
);
