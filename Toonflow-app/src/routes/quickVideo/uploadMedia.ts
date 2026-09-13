import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { persistUploadedMedia, toMediaRef, UPLOAD_MIME_EXT, UPLOAD_MAX_BYTES } from "@/lib/quickVideo/media";
import { getOwnedSession } from "@/lib/quickVideo/session";
import { QuickVideoError } from "@/lib/quickVideo/state";

const router = express.Router();

/**
 * 快创聊天粘贴/本地上传图片落库（SIY-144）：
 * - 登录态由全局 token 中间件保证；sessionId 提供时校验当前项目归属；
 * - MIME 仅允许 png/jpeg/webp，单图 <= 20MB；
 * - SHA-256 幂等：同一项目重复粘贴同一张图返回既有 MediaRef，不产生重复资产；
 * - 落库后自动进入当前项目资产白板（o_quickVideoMedia source=upload），删除聊天输入草稿不影响已入库资产；
 * - 返回标准 MediaRef（url 为按需签发的短期地址），不暴露私有 Bucket/Key，也不返回 Base64。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    mimeType: z.string().max(100),
    base64Data: z.string().min(1),
    name: z.string().max(120).optional(),
    sessionId: z.number().int().positive().optional(),
  }),
  async (req, res) => {
    const { projectId, mimeType, base64Data, name, sessionId } = req.body as {
      projectId: number;
      mimeType: string;
      base64Data: string;
      name?: string;
      sessionId?: number;
    };

    if (!UPLOAD_MIME_EXT[mimeType]) {
      return res.status(200).send(error("仅支持 PNG / JPEG / WebP 图片"));
    }

    // sessionId 提供时强校验归属关系，禁止把上传资产挂到其他项目的会话上
    if (sessionId != null) {
      try {
        await getOwnedSession(projectId, sessionId);
      } catch (err) {
        return res.status(200).send(error(err instanceof QuickVideoError ? err.message : "会话不存在或无权访问"));
      }
    }

    const buffer = Buffer.from(String(base64Data).replace(/^data:[^;]+;base64,/, ""), "base64");
    if (!buffer.length) return res.status(200).send(error("图片内容为空"));
    if (buffer.byteLength > UPLOAD_MAX_BYTES) return res.status(200).send(error("图片超过 20MB 上限"));

    try {
      const { media } = await persistUploadedMedia({
        projectId,
        sessionId: sessionId ?? null,
        buffer,
        mimeType,
        name: name ?? `粘贴图片-${new Date().toISOString().slice(5, 16).replace("T", " ")}`,
      });
      return res.status(200).send(success({ media: await toMediaRef(media) }));
    } catch (err) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message });
      }
      console.error("[quickVideo/uploadMedia] 上传失败:", err);
      return res.status(200).send(error("图片上传失败，请稍后重试"));
    }
  },
);
