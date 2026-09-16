import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QuickVideoError, loadQuickVideoState } from "@/lib/quickVideo/state";
import u from "@/utils";

const router = express.Router();

/**
 * 从资产白板删除一条素材（SIY-137 审核反馈）。
 * - 软删除：仅回写 o_quickVideoMedia.deletedAt，白板索引不再展示；聊天记录历史卡片不受影响。
 * - 删除后该媒体不可再用于生成（resolveMediaImageBase64 等按 deletedAt 拒绝），物理文件保留在 MinIO。
 * - 守门：生成中的素材不允许删除（避免任务回写悬空）；已绑定为镜头首帧的素材不允许删除（需先在分镜表解绑）。
 * 错误统一以 { code, message } 200 响应返回（同 retryShot 模式），前端 toast 展示。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    mediaId: z.number().int().positive(),
  }),
  async (req, res) => {
    const { projectId, mediaId } = req.body;
    try {
      const row = (await u.db("o_quickVideoMedia").where({ id: mediaId, projectId }).first()) as
        | { id: number; state: string; deletedAt: number | null }
        | undefined;
      if (!row || row.deletedAt) throw new QuickVideoError("MEDIA_NOT_FOUND", "未找到该素材，或不属于当前项目");
      if (row.state === "generating") {
        throw new QuickVideoError("MEDIA_GENERATING", "素材正在生成中，暂不能删除；请等待生成完成或失败后再试");
      }

      // 首帧引用守门：已绑定为镜头首帧的素材需先解绑，避免分镜重新生成时静默失效
      const state = await loadQuickVideoState(projectId);
      const boundShot = state?.storyboard?.shots.find((s) => s.firstFrame?.mediaId === mediaId);
      if (boundShot) {
        throw new QuickVideoError(
          "MEDIA_BOUND_AS_FIRST_FRAME",
          `该图片已绑定为镜头${boundShot.index}的首帧，请先在分镜表解除绑定后再删除`,
        );
      }

      await u.db("o_quickVideoMedia").where({ id: mediaId, projectId }).update({ deletedAt: Date.now(), updateTime: Date.now() });
      res.status(200).send(success({ deleted: true, mediaId }));
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message });
      }
      throw err;
    }
  },
);
