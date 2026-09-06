import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import initDB from "@/lib/initDB";
import { getTableNames } from "./tableNames";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    const { tables: importTables } = req.body;
    if (!importTables || typeof importTables !== "object") {
      return res.status(400).send(error("无效的导入数据格式"));
    }

    // 删除所有现有表
    const existingTables = await getTableNames();

    await db.raw("SET FOREIGN_KEY_CHECKS = 0");
    try {
      for (const table of existingTables) {
        await db.schema.dropTableIfExists(table);
      }
    } finally {
      await db.raw("SET FOREIGN_KEY_CHECKS = 1");
    }

    // 重新初始化表结构
    await initDB(db as any);

    // 导入数据
    const availableTables = new Set(await getTableNames());
    await db.raw("SET FOREIGN_KEY_CHECKS = 0");
    try {
      for (const [tableName, rows] of Object.entries(importTables)) {
        if (!Array.isArray(rows) || rows.length === 0 || !availableTables.has(tableName)) continue;

        // 清空表数据后插入导入数据
        await (db as any)(tableName).del();
        // 分批插入，每批100条
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100);
          await (db as any)(tableName).insert(batch);
        }
      }
    } finally {
      await db.raw("SET FOREIGN_KEY_CHECKS = 1");
    }

    res.status(200).send(success("数据库导入成功"));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "导入失败"));
  }
});
