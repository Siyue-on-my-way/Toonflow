import express from "express";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { styleExists, upsertSection, syncManualImages } from "@/utils/skillManual";
const router = express.Router();

// 字段映射表（与 queryDirectorManual 保持一致）
const VALID_KEYS = new Set(["README", "director_planning_narrative", "director_storyboard_table_narrative"]);

// 编辑导演手册
export default router.post(
  "/",
  validateFields({
    name: z.string(),
    directorManual: z.string(),
    images: z.array(z.string()),
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
      const { name, directorManual, images, data } = req.body as {
        name: string;
        directorManual: string;
        images: string[];
        data: { label: string; value: string; data: string }[];
      };

      // 安全校验：不允许包含路径分隔符、纯数字，防止越级删除或误删项目目录
      if (name.includes("/") || name.includes("\\") || name === "." || name === ".." || /^\d+$/.test(name)) {
        res.status(400).send(error("名称不能包含路径分隔符或为纯数字"));
        return;
      }

      if (!(await styleExists("story", directorManual))) {
        return res.status(400).send(error("导演手册不存在"));
      }

      for (const item of data) {
        if (!VALID_KEYS.has(item.value)) continue;
        const content = item.value === "README" ? `${name}\n${item.data}` : item.data;
        await upsertSection("story", directorManual, item.value, content);
      }

      await syncManualImages("story", directorManual, images);

      res.status(200).send(success());
    } catch (err) {
      res.status(500).send({ error: String(err) });
    }
  },
);
