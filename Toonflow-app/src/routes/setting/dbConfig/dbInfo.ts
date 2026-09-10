import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { getTableNames } from "@/utils/tableNames";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const tables = await getTableNames();

    const tableInfo = [];
    for (const table of tables) {
      const countResult = await (db as any)(table).count({ count: "*" }).first();
      tableInfo.push({
        name: table,
        rowCount: Number(countResult?.count ?? 0),
      });
    }

    res.status(200).send(success(tableInfo));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "获取数据库信息失败"));
  }
});
