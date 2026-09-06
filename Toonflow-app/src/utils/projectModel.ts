import u from "@/utils";

/**
 * 返回一次任务的文本模型覆盖值。
 *
 * 请求显式传入的模型优先，其次使用项目默认值；没有项目默认值时返回
 * undefined，让 Ai.Text 继续沿用现有 universalAi / Agent 配置兼容逻辑。
 */
export async function getProjectTextModel(projectId: number | undefined, requestedModel?: string | null): Promise<string | undefined> {
  const explicit = requestedModel?.trim();
  if (explicit) return explicit;
  if (!projectId) return undefined;

  const project = await u.db("o_project").where("id", projectId).select("textModel").first();
  const projectModel = project?.textModel?.trim();
  return projectModel || undefined;
}
