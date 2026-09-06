import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { getTableNames } from "./tableNames";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const tables = await getTableNames();

    const data: Record<string, any[]> = {};
    for (const table of tables) {
      data[table] = await (db as any)(table).select("*");
    }

    const exportData = {
      exportTime: Date.now(),
      tables: data,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=toonflow-backup-${Date.now()}.json`);
    res.status(200).send(JSON.stringify(exportData, null, 2));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "导出失败"));
  }
});
