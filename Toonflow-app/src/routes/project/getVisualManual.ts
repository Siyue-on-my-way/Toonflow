import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { listManuals, getManualImageUrls } from "@/utils/skillManual";
const router = express.Router();

// 字段映射表
const DATA_MAP: { label: string; value: string }[] = [
  { label: "README", value: "README" },
  { label: "前缀", value: "prefix" },
  { label: "角色", value: "art_character" },
  { label: "角色衍生", value: "art_character_derivative" },
  { label: "道具", value: "art_prop" },
  { label: "道具衍生", value: "art_prop_derivative" },
  { label: "场景", value: "art_scene" },
  { label: "场景衍生", value: "art_scene_derivative" },
  { label: "分镜", value: "director_storyboard" },
  { label: "分镜视频", value: "art_storyboard_video" },
  { label: "技法-导演规划", value: "director_planning_style" },
  { label: "技法-分镜表设计", value: "director_storyboard_table_style" },
];

// 获取视觉手册
export default router.post("/", async (req, res) => {
  try {
    const manuals = await listManuals("art");

    const result = await Promise.all(
      manuals.map(async ({ styleName, sections }) => {
        const images = await getManualImageUrls("art", styleName);
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
          stylePath: styleName,
          data,
        };
      }),
    );
    res.status(200).send(success(result));
  } catch (err) {
    res.status(500).send(error(u.error(err).message));
  }
});
