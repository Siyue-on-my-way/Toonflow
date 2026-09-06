import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { getTableNames } from "./tableNames";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    const { tableName } = req.body;
    if (!tableName || typeof tableName !== "string") {
      return res.status(400).send(error("请提供有效的表名"));
    }

    // 仅允许清空当前数据库中已存在的表，避免 SQL 注入。
    const tables = await getTableNames();
    if (!tables.includes(tableName)) {
      return res.status(400).send(error("表不存在"));
    }

    await (db as any)(tableName).del();

    res.status(200).send(success(`表 ${tableName} 已清空`));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "清空表失败"));
  }
});
