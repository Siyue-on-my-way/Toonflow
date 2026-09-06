import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QUICK_VIDEO_AGENT_KEY, shotCountBounds } from "@/lib/quickVideo/contract";
import { loadQuickVideoState } from "@/lib/quickVideo/state";
import { ensureGenerationRecovery } from "@/lib/quickVideo/generate";

const router = express.Router();

/**
 * 单视频快创工作台聚合查询：
 * 一次返回项目基础信息、草稿脚本、Agent 版本化状态（阶段/简报/分镜）。
 * 前端刷新/重进工作台时调用本接口完成恢复。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;

    const project = await u.db("o_project").where("id", projectId).first();
    if (!project) return res.status(200).send(success(null, "项目不存在"));
    if (project.projectType !== "quick_video") {
      return res.status(200).send(success(null, "非单视频快创项目，请使用专业模式入口"));
    }

    // 生成中断恢复（服务重启/轮询中断对账）：库内状态与进程内运行登记对不上时先修正再返回
    await ensureGenerationRecovery(projectId);

    const state = await loadQuickVideoState(projectId);
    const script = await u.db("o_script").where("projectId", projectId).select("id", "name", "content").first();

    res.status(200).send(
      success({
        project,
        script: script ?? null,
        state,
        // 分镜数量约束，供前端展示与预校验
        shotBounds: state ? shotCountBounds(state.targetDuration) : null,
      }),
    );
  },
);
