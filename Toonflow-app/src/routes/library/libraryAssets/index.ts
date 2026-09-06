import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { v4 as uuid } from "uuid";

const router = express.Router();
const table = () => (u.db as any)("o_library_asset");
const folders = () => (u.db as any)("o_asset_folder");
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MIME_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "video/mp4": "mp4", "video/webm": "webm" };
const allowedTypes = ["role", "tool", "scene", "image", "audio", "video", "clip"];
function userId(req: express.Request) { return Number((req as any).user?.id ?? 1); }
function parseData(data: string) {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(data);
  if (!match) throw new Error("文件格式不正确");
  const ext = MIME_EXT[match[1].toLowerCase()];
  if (!ext) throw new Error("不支持的文件类型");
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length || buffer.length > MAX_FILE_SIZE) throw new Error("文件大小超过 50MB 限制");
  return { buffer, mimeType: match[1].toLowerCase(), ext };
}

export default router
  .get("/", async (req, res) => {
    const owner = userId(req);
    const page = Math.max(Number(req.query.page ?? 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    let query = table().where({ createdBy: owner }).whereNull("deletedAt");
    if (req.query.folderId) query = query.andWhere("folderId", Number(req.query.folderId));
    if (req.query.type) {
      // 支持逗号分隔的多类型筛选（例如 "role,image"）
      const typeList = String(req.query.type).split(",").map((item) => item.trim()).filter((item) => allowedTypes.includes(item));
      if (typeList.length === 1) query = query.andWhere("type", typeList[0]);
      else if (typeList.length > 1) query = query.andWhere("type", "in", typeList);
    }
    if (req.query.keyword) query = query.andWhere("name", "like", `%${String(req.query.keyword)}%`);
    const [{ total }] = await query.clone().count({ total: "id" });
    const data = await query.orderBy("createdAt", "desc").offset((page - 1) * limit).limit(limit);
    const result = await Promise.all(data.map(async (asset: any) => ({ ...asset, url: await u.oss.getFileUrl(asset.filePath) })));
    res.status(200).send(success({ data: result, total: Number(total), page, limit }));
  })
  .post(
    "/upload",
    validateFields({ name: z.string().trim().min(1).max(255), type: z.enum(["role", "tool", "scene", "image", "audio", "video", "clip"]), base64Data: z.string(), folderId: z.number().int().positive().nullable().optional() }),
    async (req, res) => {
      const owner = userId(req);
      let parsed;
      try { parsed = parseData(req.body.base64Data); } catch (error) { return res.status(400).send({ message: (error as Error).message }); }
      const folderId = req.body.folderId ?? null;
      if (folderId != null && !(await folders().where({ id: folderId, createdBy: owner }).whereNull("deletedAt").first())) return res.status(404).send({ message: "目录不存在" });
      const [id] = await table().insert({ name: req.body.name, type: req.body.type, folderId, filePath: `library/${owner}/${uuid()}.${parsed.ext}`, mimeType: parsed.mimeType, size: parsed.buffer.length, metadata: JSON.stringify({ originalName: req.body.name }), createdBy: owner, createdAt: Date.now() });
      const asset = await table().where({ id }).first();
      try { await u.oss.writeFile(asset.filePath, parsed.buffer); } catch (error) { await table().where({ id }).delete(); throw error; }
      res.status(200).send(success({ ...asset, url: await u.oss.getFileUrl(asset.filePath) }));
    },
  );
