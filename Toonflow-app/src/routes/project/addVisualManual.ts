import express from "express";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { styleExists, upsertSection, syncManualImages } from "@/utils/skillManual";
const router = express.Router();

// 字段映射表（与 getVisualManual 保持一致）
const VALID_KEYS = new Set([
  "README",
  "prefix",
  "art_character",
  "art_character_derivative",
  "art_prop",
  "art_prop_derivative",
  "art_scene",
  "art_scene_derivative",
  "director_storyboard",
  "art_storyboard_video",
  "director_planning_style",
  "director_storyboard_table_style",
]);

// 新增视觉手册
export default router.post(
  "/",
  validateFields({
    name: z.string(),
    images: z.array(z.string()),
    stylePath: z.string(),
    data: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        data: z.string(),
      }),
    ),
  }),
  async (req, res) => {
    try {
      const { name, images, data, stylePath } = req.body as {
        name: string;
        images: string[];
        data: { label: string; value: string; data: string }[];
        stylePath: string;
      };

      // 安全校验：不允许包含路径分隔符、纯数字，防止越级删除或误删项目目录
      if (name.includes("/") || name.includes("\\") || name === "." || name === ".." || /^\d+$/.test(name)) {
        res.status(400).send(error("名称不能包含路径分隔符或为纯数字"));
        return;
      }

      if (await styleExists("art", stylePath)) {
        return res.status(400).send(error("请勿填写重复名称的视觉手册"));
      }

      for (const item of data) {
        if (!VALID_KEYS.has(item.value)) continue;
        await upsertSection("art", stylePath, item.value, item.data);
      }

      await syncManualImages("art", stylePath, images);

      res.status(200).send(success());
    } catch (err) {
      res.status(500).send({ error: String(err) });
    }
  },
);
