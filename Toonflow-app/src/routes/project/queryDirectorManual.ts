import express from "express";
import { success } from "@/lib/responseFormat";
import { listManuals, getManualImageUrls } from "@/utils/skillManual";
const router = express.Router();

// 字段映射表
const DATA_MAP: { label: string; value: string }[] = [
  { label: "README", value: "README" },
  { label: "导演规划", value: "director_planning_narrative" },
  { label: "分镜表", value: "director_storyboard_table_narrative" },
];

// 获取导演手册
export default router.post("/", async (req, res) => {
  try {
    const manuals = await listManuals("story");

    const result = await Promise.all(
      manuals.map(async ({ styleName, sections }) => {
        const images = await getManualImageUrls("story", styleName);
        const readmeContent = sections["README"] ?? "";
        const firstLine = readmeContent.split("\n")[0].replace(/--/g, "");
        const data = DATA_MAP.map(({ label, value }) => ({
          label,
          value,
          data: sections[value] ?? "",
        }));

        return {
          name: firstLine,
          image: images,
          directorManual: styleName,
          data,
        };
      }),
    );
    res.status(200).send(success(result));
  } catch (err) {
    res.status(500).send({ error: String(err) });
  }
});
