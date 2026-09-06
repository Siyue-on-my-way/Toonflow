import express from "express";
import { z } from "zod";
import u from "@/utils";
import { db as knexDb } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QUICK_VIDEO_PROJECT_TYPE, QUICK_VIDEO_RATIOS, QuickVideoState } from "@/lib/quickVideo/contract";
import { findProjectByCreateIdempotencyKey, initQuickVideoStateRow } from "@/lib/quickVideo/state";

const router = express.Router();

/**
 * 新增单视频快创（quick_video）项目。
 * 与专业模式 addProject 并存：不走旧链路，不改旧行为。
 * - 幂等键防重复创建：同键重复提交返回首次创建的项目。
 * - 事务内同时落 o_project、草稿脚本（可选，复用 o_script）与 quickVideoAgent 初始状态。
 */
export default router.post(
  "/",
  validateFields({
    name: z.string().min(1).max(100),
    artStyle: z.string().max(500).default(""),
    videoRatio: z.enum(QUICK_VIDEO_RATIOS),
    targetDuration: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    draftScript: z.string().max(20000).optional().default(""),
    intro: z.string().max(2000).optional().default(""),
    idempotencyKey: z.string().min(8).max(64),
  }),
  async (req, res) => {
    const { name, artStyle, videoRatio, targetDuration, draftScript, intro, idempotencyKey } = req.body;

    // 幂等：同键已创建过则直接返回既有项目
    const existingProjectId = await findProjectByCreateIdempotencyKey(idempotencyKey);
    if (existingProjectId != null) {
      const project = await u.db("o_project").where("id", existingProjectId).first();
      return res.status(200).send(success({ projectId: existingProjectId, existed: true, project }));
    }

    const projectId = await knexDb.transaction(async (trx) => {
      const maxRow = await trx("o_project").max("id as maxId").first();
      const id = Number(maxRow?.maxId ?? 0) + 1;

      await trx("o_project").insert({
        id,
        projectType: QUICK_VIDEO_PROJECT_TYPE,
        name,
        intro,
        type: "quick_video",
        artStyle,
        videoRatio,
        directorManual: "",
        userId: 1,
        imageModel: "",
        videoModel: "",
        imageQuality: "",
        mode: "",
        createTime: Date.now(),
      });

      if (draftScript && draftScript.trim()) {
        const scriptMaxRow = await trx("o_script").max("id as maxId").first();
        const scriptId = Number(scriptMaxRow?.maxId ?? 0) + 1;
        await trx("o_script").insert({
          id: scriptId,
          projectId: id,
          name: `${name}-草稿`,
          content: draftScript,
          createTime: Date.now(),
        });
      }

      await initQuickVideoStateRow(trx, { projectId: id, idempotencyKey, targetDuration, videoRatio, artStyle });

      return id;
    });

    const project = await u.db("o_project").where("id", projectId).first();
    const state: QuickVideoState | null = await (async () => {
      const row = await u.db("o_agentWorkData").where({ projectId, key: "quickVideoAgent" }).first();
      return row && row.data ? JSON.parse(row.data) : null;
    })();

    res.status(200).send(success({ projectId, existed: false, project, state }));
  },
);
