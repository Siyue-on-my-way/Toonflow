import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import initDB from "@/lib/initDB";
import { getTableNames } from "@/utils/tableNames";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const tables = await getTableNames();

    await db.raw("SET FOREIGN_KEY_CHECKS = 0");
    try {
      for (const table of tables) {
        await db.schema.dropTableIfExists(table);
      }
    } finally {
      await db.raw("SET FOREIGN_KEY_CHECKS = 1");
    }

    // 重新初始化数据库
    await initDB(db as any);

    res.status(200).send(success("数据库已清空并重新初始化"));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "清除失败"));
  }
});
