import express from "express";
import { success } from "@/lib/responseFormat";
import fg from "fast-glob";
import u from "@/utils";
import db from "@/utils/db";
import { sectionVirtualPath, type ManualType } from "@/utils/skillManual";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const skillsRoot = u.getPath(["skills"]);

  // 本地技能文件（Agent 执行脚本等随代码打包的固定 md），排除已迁移至 skill_manual 表的 art_skills/story_skills
  const localEntries = await fg("**/*.md", {
    cwd: skillsRoot.replace(/\\/g, "/"),
    onlyFiles: true,
    ignore: ["art_skills/**", "story_skills/**"],
  });

  // 已迁移至数据库的视觉手册/导演手册，还原为兼容旧路径的虚拟路径
  const manualRows = await db("skill_manual").select("type", "styleName", "sectionKey");
  const manualEntries = manualRows.map((row) => sectionVirtualPath(row.type as ManualType, row.styleName, row.sectionKey));

  res.status(200).send(success([...localEntries, ...manualEntries]));
});
