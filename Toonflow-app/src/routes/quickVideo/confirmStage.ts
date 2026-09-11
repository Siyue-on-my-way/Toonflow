import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QuickVideoError, mutateQuickVideoState, loadQuickVideoState } from "@/lib/quickVideo/state";
import { buildPendingSnapshot, validateStoryboard } from "@/lib/quickVideo/contract";
import { buildSnapshot, applySnapshotToState, startQuickVideoGeneration } from "@/lib/quickVideo/generate";
import { recordEvent, qvLog } from "@/lib/quickVideo/metrics";
import { getOwnedSession } from "@/lib/quickVideo/session";

const router = express.Router();

/**
 * 用户确认门（三个关键确认点的统一入口）：
 * - brief      简报确认：collect_brief -> brief_confirmed；reject 回退到 collect_brief
 * - storyboard 分镜确认：storyboard_draft -> storyboard_confirmed（校验镜头数量/时长）；reject 回草稿解锁编辑
 * - materials  素材/成本确认：storyboard_confirmed -> generating（冻结不可歧义的生成快照并启动逐镜头生成）；
 *              reject 清除素材确认（停在 storyboard_confirmed，可重新解析素材）
 * - export     成片导出确认：ready_to_assemble -> completed（装配/导出由后续任务接入）
 * 仅用户可推进确认门；Agent 工具无权调用本接口。门的判定全部在服务端完成。
 * sessionId 必须真实属于该项目（校验跨项目/非法引用）；素材确认门据此把生成模型偏好定位到当前会话，
 * 并把触发该次写入的会话留痕到 o_agentWorkData.sessionId。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    sessionId: z.number(),
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(8).max(64),
    gate: z.enum(["brief", "storyboard", "materials", "export"]),
    action: z.enum(["confirm", "reject"]),
    /** gate=export 时可选回写的导出结果（浏览器端 WebAV 编码成功后携带） */
    exportInfo: z
      .object({
        fileName: z.string().min(1).max(200),
        sizeBytes: z.number().int().min(0),
        durationSeconds: z.number().min(0),
      })
      .optional(),
  }),
  async (req, res) => {
    const { projectId, sessionId, expectedVersion, idempotencyKey, gate, action, exportInfo } = req.body;
    try {
      await getOwnedSession(projectId, sessionId);
    } catch (err) {
      if (err instanceof QuickVideoError) return res.status(200).send(error(err.message));
      throw err;
    }
    let shouldStartGeneration = false;
    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey, sessionId }, async (state) => {
        if (gate === "brief") {
          if (!state.brief) throw new QuickVideoError("NO_BRIEF", "暂无简报，无法操作", state.version);
          if (action === "confirm") {
            if (!["collect_brief", "storyboard_draft", "brief_confirmed"].includes(state.stage)) {
              throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许确认简报`, state.version);
            }
            // collect_brief -> brief_confirmed 为白名单转移；brief_confirmed 保持不变（重复确认幂等）
            state.stage = "brief_confirmed";
            state.brief.confirmed = true;
            state.brief.confirmedAt = Date.now();
          } else {
            if (state.stage !== "brief_confirmed" && state.stage !== "collect_brief") {
              throw new QuickVideoError("STAGE_MISMATCH", "简报已进入后续流程，请改为直接编辑简报", state.version);
            }
            state.stage = "collect_brief";
            state.brief.confirmed = false;
            state.brief.confirmedAt = null;
          }
          return;
        }

        if (gate === "storyboard") {
          if (!state.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜，无法操作", state.version);
          if (action === "confirm") {
            if (state.stage !== "storyboard_draft") {
              throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许确认分镜`, state.version);
            }
            if (state.targetDuration == null) {
              throw new QuickVideoError("DURATION_NOT_SET", "目标时长尚未确定，请先在对话中确认视频时长（5-60 秒的整数）", state.version);
            }
            const errors = validateStoryboard(state.targetDuration, state.storyboard.shots);
            if (errors.length) throw new QuickVideoError("STORYBOARD_INVALID", errors.join("；"), state.version);
            state.stage = "storyboard_confirmed";
            state.storyboard.status = "confirmed";
            state.storyboard.confirmedAt = Date.now();
          } else {
            if (state.stage !== "storyboard_confirmed") {
              throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不需要撤销分镜确认`, state.version);
            }
            state.stage = "storyboard_draft";
            state.storyboard.status = "draft";
            state.storyboard.confirmedAt = null;
          }
          return;
        }

        if (gate === "materials") {
          if (!state.storyboard || state.storyboard.status !== "confirmed") {
            throw new QuickVideoError("NO_STORYBOARD", "分镜尚未确认，请先通过分镜确认门", state.version);
          }
          if (action === "confirm") {
            if (state.stage !== "storyboard_confirmed") {
              throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许素材确认`, state.version);
            }
            // SIY-138 生成确认门：存在未失效的待确认摘要时，其 configVersion 必须仍是最新值，
            // 否则说明确认后参数/分镜又被修改过，旧确认凭证作废，需重新发起生成确认。
            if (state.confirmationStatus === "pending" && state.pendingSnapshot && state.pendingSnapshot.configVersion !== state.configVersion) {
              throw new QuickVideoError("CONFIG_VERSION_MISMATCH", "参数已变更，原生成确认已失效；请重新发起生成确认", state.version);
            }
            if (state.targetDuration == null) {
              throw new QuickVideoError("DURATION_NOT_SET", "目标时长尚未确定，请先在对话中确认视频时长（5-60 秒）", state.version);
            }
            // 快照缺失或分镜版本已变化时，服务端现场重新解析（门的判定不依赖前端传值）
            const needResolve =
              !state.generation?.snapshot || state.generation.snapshot.storyboardVersion !== state.storyboard.version;
            if (needResolve) {
              const { materials, estimate, snapshotShots } = await buildSnapshot(projectId, state);
              applySnapshotToState(state, state.storyboard.version, snapshotShots, materials, estimate);
            }
            if (!state.generation.snapshot) {
              throw new QuickVideoError("MATERIALS_RESOLVE_FAILED", "素材解析失败，无法确认", state.version);
            }
            state.generation.materialsConfirmed = true;
            state.generation.materialsConfirmedAt = Date.now();
            state.generation.startedAt = Date.now();
            state.generation.finishedAt = null;
            // 面板路径确认同样留下版本化的确认凭证（审计/锁定展示用）
            const fresh = buildPendingSnapshot(state, {
              estimatedImageCount: state.generation.snapshot.estimatedImageCount,
              estimatedVideoCount: state.generation.snapshot.estimatedVideoCount,
              estimatedCostYuan: state.generation.snapshot.estimatedCostYuan,
            });
            state.pendingSnapshot = fresh;
            state.confirmationStatus = "confirmed";
            state.stage = "generating";
            shouldStartGeneration = true;
          } else {
            if (state.stage !== "storyboard_confirmed") {
              throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许撤销素材确认`, state.version);
            }
            state.generation.materialsConfirmed = false;
            state.generation.materialsConfirmedAt = null;
            state.pendingSnapshot = null;
            state.confirmationStatus = "none";
          }
          return;
        }

        // gate === "export"（第三道确认门：ready_to_assemble -> completed；completed 允许携带新结果幂等重确认）
        if (action !== "confirm") {
          throw new QuickVideoError("FORBIDDEN", "导出无需撤销，未导出即可继续编辑", state.version);
        }
        if (state.stage !== "ready_to_assemble" && state.stage !== "completed") {
          throw new QuickVideoError("STAGE_MISMATCH", "尚未完成全部镜头生成，无法导出", state.version);
        }
        state.stage = "completed";
        if (exportInfo) {
          state.generation.exportInfo = { exportedAt: Date.now(), ...exportInfo };
        }
      });
      if (gate === "export" && action === "confirm" && !result.idempotentHit) {
        recordEvent("exportConfirmed");
        qvLog("export_confirmed", { projectId, sizeBytes: exportInfo?.sizeBytes ?? null, durationSeconds: exportInfo?.durationSeconds ?? null });
      }
      res.status(200).send(success({ state: result.state, idempotentHit: result.idempotentHit }));

      // 素材确认门通过后启动逐镜头生成（分离运行，接口已返回；启动失败不回滚确认，
      // 用户可通过失败镜头重试或 Agent 的 generate_shots 幂等重启）
      if (shouldStartGeneration && !result.idempotentHit) {
        try {
          const start = await startQuickVideoGeneration(projectId, (req as any).user?.id ?? 1, sessionId);
          if (start.started) console.log(`[quickVideo] 项目 ${projectId} 生成已启动（${start.runId}）`);
        } catch (err: any) {
          console.error(`[quickVideo] 项目 ${projectId} 确认后启动生成失败:`, u.error(err).message);
        }
      }
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
