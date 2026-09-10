import { db } from "@/utils/db";

const databaseName = process.env.DB_NAME || "toonflow_db";

/** Return application tables from the configured MySQL schema. */
export async function getTableNames(): Promise<string[]> {
  const rows: Array<{ name: string }> = await (db as any)("information_schema.tables")
    .select({ name: "TABLE_NAME" })
    .where("TABLE_SCHEMA", databaseName)
    .where("TABLE_TYPE", "BASE TABLE")
    .whereRaw("TABLE_NAME NOT LIKE ?", ["knex_%"])
    .orderBy("TABLE_NAME");

  return rows.map((row) => row.name);
}
