// 视觉手册(art_skills) / 导演手册(story_skills) 的存储层：文本存 MySQL(skill_manual)，图片存 MinIO(skill_manual_image 记录 key)
// 替代原来直接读写本地 data/skills 目录的方式，实现无状态化
import path from "path";
import { v4 as uuidv4 } from "uuid";
import db from "@/utils/db";
import oss from "@/utils/oss";

export type ManualType = "art" | "story";

// sectionKey -> 原本所在的子目录（用于兼容旧的虚拟路径，供 skillManagement 使用）
const SECTION_SUBDIR: Record<ManualType, Record<string, string | undefined>> = {
  art: {
    README: undefined,
    prefix: undefined,
    art_character: "art_prompt",
    art_character_derivative: "art_prompt",
    art_prop: "art_prompt",
    art_prop_derivative: "art_prompt",
    art_scene: "art_prompt",
    art_scene_derivative: "art_prompt",
    art_storyboard_video: "art_prompt",
    director_storyboard: "driector_skills",
    director_planning_style: "driector_skills",
    director_storyboard_table_style: "driector_skills",
  },
  story: {
    README: undefined,
    director_planning_narrative: "driector_skills",
    director_storyboard_table_narrative: "driector_skills",
  },
};

export function styleRootDir(type: ManualType): "art_skills" | "story_skills" {
  return type === "art" ? "art_skills" : "story_skills";
}

// 构建与迁移前本地文件路径一致的虚拟路径，用于 skillManagement 兼容旧的按路径读写方式
export function sectionVirtualPath(type: ManualType, styleName: string, sectionKey: string): string {
  const root = styleRootDir(type);
  const subDir = SECTION_SUBDIR[type][sectionKey];
  return subDir ? `${root}/${styleName}/${subDir}/${sectionKey}.md` : `${root}/${styleName}/${sectionKey}.md`;
}

// 反解虚拟路径，非视觉/导演手册范围内的路径返回 null（交由调用方走本地文件系统兜底）
export function parseVirtualPath(virtualPath: string): { type: ManualType; styleName: string; sectionKey: string } | null {
  const m = virtualPath.match(/^(art_skills|story_skills)\/([^/]+)\/(?:(?:art_prompt|driector_skills)\/)?([^/]+)\.md$/);
  if (!m) return null;
  return { type: m[1] === "art_skills" ? "art" : "story", styleName: m[2], sectionKey: m[3] };
}

export async function styleExists(type: ManualType, styleName: string): Promise<boolean> {
  const row = await db("skill_manual").where({ type, styleName }).first();
  return !!row;
}

export async function getSection(type: ManualType, styleName: string, sectionKey: string): Promise<string> {
  const row = await db("skill_manual").where({ type, styleName, sectionKey }).first();
  return row?.content ?? "";
}

export async function sectionExists(type: ManualType, styleName: string, sectionKey: string): Promise<boolean> {
  const row = await db("skill_manual").where({ type, styleName, sectionKey }).first();
  return !!row;
}

export async function getAllSections(type: ManualType, styleName: string): Promise<Record<string, string>> {
  const rows = await db("skill_manual").where({ type, styleName });
  const result: Record<string, string> = {};
  for (const row of rows) result[row.sectionKey] = row.content ?? "";
  return result;
}

// 获取某风格下"导演技法"类 section（原本存放在 driector_skills 子目录），供 productionAgent 的技能加载使用
export async function getDirectorSkillSections(type: ManualType, styleName: string): Promise<{ sectionKey: string; content: string }[]> {
  const keys = Object.entries(SECTION_SUBDIR[type])
    .filter(([, subDir]) => subDir === "driector_skills")
    .map(([key]) => key);
  if (!keys.length) return [];
  const rows = await db("skill_manual").where({ type, styleName }).whereIn("sectionKey", keys);
  return rows.map((row) => ({ sectionKey: row.sectionKey, content: row.content ?? "" }));
}

export async function upsertSection(type: ManualType, styleName: string, sectionKey: string, content: string): Promise<void> {
  const now = Date.now();
  const existing = await db("skill_manual").where({ type, styleName, sectionKey }).first();
  if (existing) {
    await db("skill_manual").where({ type, styleName, sectionKey }).update({ content, updateTime: now });
  } else {
    await db("skill_manual").insert({ id: uuidv4(), type, styleName, sectionKey, content, createTime: now, updateTime: now });
  }
}

// 按 (type, styleName) 列出所有手册，section 内容按 sectionKey 归组
export async function listManuals(type: ManualType): Promise<{ styleName: string; sections: Record<string, string> }[]> {
  const rows = await db("skill_manual").where({ type });
  const map = new Map<string, Record<string, string>>();
  for (const row of rows) {
    if (!map.has(row.styleName)) map.set(row.styleName, {});
    map.get(row.styleName)![row.sectionKey] = row.content ?? "";
  }
  return Array.from(map.entries()).map(([styleName, sections]) => ({ styleName, sections }));
}

export async function deleteManual(type: ManualType, styleName: string): Promise<void> {
  await db("skill_manual").where({ type, styleName }).delete();
  await db("skill_manual_image").where({ type, styleName }).delete();
  await oss.deleteDirectory(`${styleRootDir(type)}/${styleName}/`).catch(() => {});
}

async function listImageKeys(type: ManualType, styleName: string): Promise<string[]> {
  const rows = await db("skill_manual_image").where({ type, styleName });
  return rows.map((r) => r.ossKey);
}

// 获取手册当前图片的访问 URL 列表
export async function getManualImageUrls(type: ManualType, styleName: string): Promise<string[]> {
  const keys = await listImageKeys(type, styleName);
  return Promise.all(keys.map((key) => oss.getFileUrl(key, "skills")));
}

// 依据前端传入的 images（保留的以 http 开头的 URL + 新增的 base64）同步 MinIO 图片与 skill_manual_image 记录
export async function syncManualImages(type: ManualType, styleName: string, images: string[]): Promise<void> {
  const root = styleRootDir(type);
  const existingKeys = await listImageKeys(type, styleName);
  const retainedBasenames = new Set(images.filter((item) => item.startsWith("http")).map((url) => path.basename(new URL(url).pathname)));

  for (const key of existingKeys) {
    if (!retainedBasenames.has(path.basename(key))) {
      await oss.deleteFile(key).catch(() => {});
      await db("skill_manual_image").where({ type, styleName, ossKey: key }).delete();
    }
  }

  for (const item of images) {
    if (!item.startsWith("http")) {
      const ossKey = `${root}/${styleName}/images/${uuidv4()}.jpg`;
      await oss.writeFile(ossKey, item);
      await db("skill_manual_image").insert({ id: uuidv4(), type, styleName, ossKey, createTime: Date.now() });
    }
  }
}
