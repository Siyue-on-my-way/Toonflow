import db from "@/utils/db";

const taskStateMap = {
  "0": "进行中",
  "1": "已完成",
  "-1": "生成失败",
};
/**
 * 记录任务并返回结束函数
 * @param projectId  项目 ID
 * @param taskClass  任务分类
 * @param modelName   模型名称
 * @param opts       可选项：关联对象、任务描
 */
export default async function taskRecord(
  projectId: number,
  taskClass: string,
  modelName: string,
  opts: {
    describe?: string;
    content?: any;
  } = {},
) {
  const { content, describe = "" } = opts;

  let opteorContent: string | undefined;
  if (content === undefined || content === null) {
    opteorContent = undefined;
  } else if (typeof content === "string") {
    opteorContent = content;
  } else if (typeof content === "function") {
    throw new Error("不支持的类型");
  } else {
    try {
      opteorContent = JSON.stringify(content);
    } catch (e) {
      opteorContent = content.toString();
    }
  }

  let id = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const maxRow = (await db("o_tasks").max("id as maxId").first()) as { maxId?: number | string } | undefined;
    id = Number(maxRow?.maxId ?? 0) + 1;
    try {
      await db("o_tasks").insert({
        id,
        projectId,
        taskClass,
        relatedObjects: opteorContent,
        model: modelName,
        describe,
        state: taskStateMap[0],
        startTime: Date.now(),
      });
      break;
    } catch (e: any) {
      const duplicate = e?.code === "ER_DUP_ENTRY" || /duplicate entry|unique constraint/i.test(String(e?.message));
      if (!duplicate || attempt === 9) throw e;
    }
  }

  /** 任务成功时调用 done(1)，失败时调用 done(-1, '原因') */
  const done = async (state: 1 | -1, reason?: string) => {
    await db("o_tasks")
      .where("id", id)
      .update({
        state: taskStateMap[state],
        reason: state === -1 ? (reason ?? "") : null,
      });
  };

  // Provider 适配器在提交异步任务后调用此方法，使任务中心能追踪上游 taskId。
  // 该字段是可选的，因此不影响其它供应商和旧数据库。
  const setProviderTaskId = async (providerTaskId: string) => {
    if (!providerTaskId) return;
    await db("o_tasks").where("id", id).update({ providerTaskId });
  };
  return Object.assign(done, { id, setProviderTaskId });
}
