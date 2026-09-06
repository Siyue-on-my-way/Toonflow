import knex from "knex";
import initDB from "@/lib/initDB";
import type { DB } from "@/types/database";
import fixDB from "@/lib/fixDB";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];

const dbClientName = (process.env.DB_CLIENT || "").trim().toLowerCase();
if (dbClientName !== "mysql") {
  throw new Error(
    `[数据库配置错误] 当前服务只支持 MySQL，必须设置 DB_CLIENT=mysql；当前值为 ${process.env.DB_CLIENT || "未设置"}`,
  );
}

const db = knex({
  client: "mysql2",
  connection: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "toonflow",
    password: process.env.DB_PASSWORD || "toonflow_pass",
    database: process.env.DB_NAME || "toonflow_db",
  },
  useNullAsDefault: true,
});

(async () => {
  await initDB(db);
  await fixDB(db);
})();

const dbClient = Object.assign(<TName extends TableName>(table: TName) => db<RowType<TName>, RowType<TName>[]>(table), db);
dbClient.schema = db.schema;
export default dbClient;

export { db };

// o_assets2Storyboard 使用显式自增 id 保存关联素材的插入顺序。
export function orderByInsertOrder<T extends { orderBy: (column: string) => T }>(query: T): T {
  return query.orderBy("id");
}
