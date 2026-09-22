import knex from "knex";
import path from "path";
import { vendor } from "./src/vendors/libtv";

/**
 * LibTV 渠道一次性初始化脚本（已有数据库环境用，全新环境走 initDB 的 initData）。
 *
 * 幂等：o_vendorConfig 里已有 libtv 行时什么都不做，绝不覆盖现有协议目录/密钥。
 * 用法：npx tsx init-libtv-db.ts
 */
async function main() {
  let db: knex.Knex;
  if (process.env.DB_CLIENT === "pg" || process.env.DB_CLIENT === "mysql") {
    db = knex({
      client: process.env.DB_CLIENT === "pg" ? "pg" : "mysql2",
      connection: {
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || (process.env.DB_CLIENT === "pg" ? "5432" : "3306")),
        user: process.env.DB_USER || "toonflow",
        password: process.env.DB_PASSWORD || "toonflow_pass",
        database: process.env.DB_NAME || "toonflow_db",
      },
      useNullAsDefault: true,
    });
  } else {
    db = knex({
      client: "better-sqlite3",
      connection: { filename: path.resolve(process.cwd(), "data", "db2.sqlite") },
      useNullAsDefault: true,
    });
  }

  try {
    const existing = await db("o_vendorConfig").where("id", vendor.id).first();
    if (existing) {
      console.log(`o_vendorConfig 已存在 id=${vendor.id}，跳过（不覆盖现有配置）。`);
      return;
    }
    await db("o_vendorConfig").insert({
      id: vendor.id,
      enable: 0,
      inputValues: JSON.stringify({}),
      models: JSON.stringify(vendor.models),
      enabledModels: "[]",
    });
    console.log(`已插入 o_vendorConfig id=${vendor.id}，模型目录 ${vendor.models.length} 条。后续在设置页启用渠道与模型、配置 CLI 凭据即可。`);
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
