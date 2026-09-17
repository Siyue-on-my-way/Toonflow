import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import { tool, jsonSchema } from "ai";
const router = express.Router();

// 检查语言模型
export default router.post(
  "/",
  validateFields({
    modelName: z.string(),
    id: z.string(),
    mode: z.string(),
    // Kling O1 / minimax fl2va 的提示词为可选（文档口径）；模型级必填由供应商 DSL 拦截
    prompt: z.string().optional(),
    videos: z.array(
      z.object({
        type: z.string(),
        base64: z.string(),
      }),
    ),
    audios: z.array(
      z.object({
        type: z.string(),
        base64: z.string(),
      }),
    ),
    images: z.array(
      z.object({
        type: z.string(),
        base64: z.string(),
      }),
    ),
    // SIY-159：参数面板透传（时长/分辨率/比例/画质档/高级开关）；缺省时按模型目录取默认值
    duration: z.number().optional(),
    resolution: z.string().optional(),
    aspectRatio: z.string().optional(),
    quality: z.enum(["std", "pro"]).optional(),
    generateAudio: z.boolean().optional(),
    seed: z.number().int().optional(),
    returnLastFrame: z.boolean().optional(),
  }),
  async (req, res) => {
    const { modelName, id, mode, prompt, images, videos, audios, duration, resolution, aspectRatio, quality, generateAudio, seed, returnLastFrame } = req.body;

    try {
      const vendorConfigData = await u.db("o_vendorConfig").where("id", id).first();

      if (!vendorConfigData) return res.status(500).send(error("未找到该供应商配置"));
      if (!vendorConfigData.models) return res.status(500).send(error("未找到模型列表"));
      const modelList = await u.vendor.getModelList(vendorConfigData.id!);

      const selectedModel = modelList.find((i: any) => i.modelName == modelName);

      let modeData = [];
      if (Array.isArray(mode)) {
      } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
        try {
          modeData = JSON.parse(mode);
        } catch (e) {}
      }
      // 时长/分辨率默认值取模型目录首档；时长优先取 5s（常用默认），不存在该档位再回退首档
      const durationOptions: number[] = selectedModel.durationResolutionMap?.[0]?.duration ?? [];
      const defaultDuration = durationOptions.includes(5) ? 5 : durationOptions[0];
      const resReq: any = {
        duration: duration ?? defaultDuration,
        resolution: resolution ?? selectedModel.durationResolutionMap[0].resolution[0],
        aspectRatio: aspectRatio ?? "16:9",
        prompt: prompt ?? "",
        referenceList: [...images, ...videos, ...audios],
        audio: typeof selectedModel.audio == "boolean" ? selectedModel.audio : true,
        mode: modeData.length > 0 ? modeData : mode,
      };
      if (quality !== undefined) resReq.quality = quality;
      if (generateAudio !== undefined) resReq.generateAudio = generateAudio;
      if (seed !== undefined) resReq.seed = seed;
      if (returnLastFrame !== undefined) resReq.returnLastFrame = returnLastFrame;
      const reqFn = await u.Ai.Video(`${id}:${modelName}`, (req as any).user.id).run(resReq);
      await reqFn.save("test.mp4");
      const resultUrl = await u.oss.getFileUrl("test.mp4");
      res.status(200).send(success(resultUrl));
    } catch (err) {
      console.error(err);
      const msg = u.error(err).message;
      console.error(msg);
      res.status(500).send(error(msg));
    }
  },
);
