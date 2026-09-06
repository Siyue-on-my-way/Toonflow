import { getSection, getAllSections, type ManualType } from "@/utils/skillManual";

function sourceToType(source: string): ManualType {
  return source === "story_skills" ? "story" : "art";
}

/**
 * 传入一个指定风格名称，以及一个指定 section 名，从 skill_manual 表读取内容并返回
 * @param styleName - 风格目录名，例如 "chinese_sweet_romance"
 * @param source - "art_skills" | "story_skills"
 * @param fileName  - 目标 section 名（不含 .md 后缀），例如 "art_character"、"prefix"
 * @returns 文件内容字符串，未找到时返回空字符串
 */
export async function getArtPrompt(styleName: string, source: string, fileName: string): Promise<string> {
  const type = sourceToType(source);
  const prefixContent = await getSection(type, styleName, "prefix");

  const sectionKey = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  const fileContent = await getSection(type, styleName, sectionKey);

  if (!fileContent) {
    return prefixContent;
  }

  return prefixContent ? `${prefixContent}\n${fileContent}` : fileContent;
}

/**
 * 传入风格目录名，获取该风格下所有 section 内容，按 sectionKey 映射返回
 * @param styleName - 风格目录名，例如 "chinese_sweet_romance"
 * @param source - "art_skills" | "story_skills"
 * @returns Record<sectionKey, 文件内容>
 */
export async function getAllArtPrompts(styleName: string, source: string): Promise<Record<string, string>> {
  return getAllSections(sourceToType(source), styleName);
}
