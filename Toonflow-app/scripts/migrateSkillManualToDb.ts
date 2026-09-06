// 一次性迁移脚本：将本地 data/skills/art_skills、data/skills/story_skills 下的 md 内容灌入 skill_manual 表，
// 并为已存在于 MinIO 的图片（由 scripts/migrateStaticToOss.ts 上传）建立 skill_manual_image 记录
// 用法：tsx scripts/migrateSkillManualToDb.ts
//
// 注意：这里不复用 @/utils/db 单例——它的模块级 IIFE 会连带触发 fixDB 里与本迁移无关的历史数据修正逻辑，
// 单独起一个 knex 连接，只负责本脚本需要的两张表，避免引入不相关的副作用
import fs from "fs";
import path from "path";
import knex, { Knex } from "knex";
import getPath from "@/utils/getPath";
import { v4 as uuid } from "uuid";
import type { ManualType } from "@/utils/skillManual";

function buildDb(): Knex {
  if ((process.env.DB_CLIENT || "").trim().toLowerCase() !== "mysql") {
    throw new Error("[数据库配置错误] 迁移脚本只支持 MySQL，必须设置 DB_CLIENT=mysql");
  }
  return knex({
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
}

const db = buildDb();

async function ensureTables() {
  if (!(await db.schema.hasTable("skill_manual"))) {
    await db.schema.createTable("skill_manual", (table) => {
      table.string("id", 64).notNullable();
      table.string("type", 16).notNullable();
      table.string("styleName", 128).notNullable();
      table.string("sectionKey", 64).notNullable();
      table.text("content");
      table.bigInteger("createTime");
      table.bigInteger("updateTime");
      table.primary(["id"]);
      table.unique(["type", "styleName", "sectionKey"]);
    });
  }
  if (!(await db.schema.hasTable("skill_manual_image"))) {
    await db.schema.createTable("skill_manual_image", (table) => {
      table.string("id", 64).notNullable();
      table.string("type", 16).notNullable();
      table.string("styleName", 128).notNullable();
      table.text("ossKey").notNullable();
      table.bigInteger("createTime");
      table.primary(["id"]);
      table.index(["type", "styleName"]);
    });
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

function walkMd(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkMd(full));
    else if (entry.name.endsWith(".md")) result.push(full);
  }
  return result;
}

async function upsertSection(type: ManualType, styleName: string, sectionKey: string, content: string) {
  const now = Date.now();
  const existing = await db("skill_manual").where({ type, styleName, sectionKey }).first();
  if (existing) {
    await db("skill_manual").where({ type, styleName, sectionKey }).update({ content, updateTime: now });
  } else {
    await db("skill_manual").insert({ id: uuid(), type, styleName, sectionKey, content, createTime: now, updateTime: now });
  }
}

async function migrateType(type: ManualType, root: "art_skills" | "story_skills") {
  const baseDir = getPath(["skills", root]);
  if (!fs.existsSync(baseDir)) {
    console.warn(`[跳过] 目录不存在: ${baseDir}`);
    return;
  }
  const styleNames = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const styleName of styleNames) {
    const styleDir = path.join(baseDir, styleName);
    const mdFiles = walkMd(styleDir);
    for (const filePath of mdFiles) {
      const sectionKey = path.basename(filePath, ".md");
      const content = fs.readFileSync(filePath, "utf-8");
      await upsertSection(type, styleName, sectionKey, content);
    }

    const imagesDir = path.join(styleDir, "images");
    let imageCount = 0;
    if (fs.existsSync(imagesDir)) {
      const files = fs.readdirSync(imagesDir).filter((f) => IMAGE_EXT.test(f));
      for (const file of files) {
        const ossKey = `${root}/${styleName}/images/${file}`;
        const existing = await db("skill_manual_image").where({ type, styleName, ossKey }).first();
        if (!existing) {
          await db("skill_manual_image").insert({ id: uuid(), type, styleName, ossKey, createTime: Date.now() });
        }
        imageCount++;
      }
    }
    console.log(`[完成] ${type}:${styleName} sections=${mdFiles.length} images=${imageCount}`);
  }
}

async function main() {
  await ensureTables();
  await migrateType("art", "art_skills");
  await migrateType("story", "story_skills");
  console.log("视觉手册/导演手册数据迁移完成");
}

main()
  .catch((e) => {
    console.error("迁移失败:", e);
    process.exitCode = 1;
  })
  .finally(() => db.destroy().then(() => process.exit()));
