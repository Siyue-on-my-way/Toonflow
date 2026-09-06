// 一次性迁移脚本：将本地 data/skills、data/assets、data/web 上传至 MinIO
// 用法：tsx scripts/migrateStaticToOss.ts
import fs from "fs";
import path from "path";
import getPath from "@/utils/getPath";
import oss from "@/utils/oss";

function walk(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}

// keyPrefix 为空字符串时，OSS key 与本地相对路径一致（对应 app.ts 里 /skills、/assets 的直读逻辑）
// keyPrefix 为 "web" 时，OSS key 为 `web/<相对路径>`（对应 app.ts 里前端静态网站的读取逻辑）
async function migrateDir(localDir: string, keyPrefix: string) {
  if (!fs.existsSync(localDir)) {
    console.warn(`[跳过] 目录不存在: ${localDir}`);
    return;
  }
  const files = walk(localDir);
  console.log(`[开始] ${localDir} 共 ${files.length} 个文件`);
  for (const file of files) {
    const relPath = path.relative(localDir, file).split(path.sep).join("/");
    const objectKey = keyPrefix ? `${keyPrefix}/${relPath}` : relPath;
    const data = fs.readFileSync(file);
    await oss.writeFile(objectKey, data);
    console.log(`  上传: ${objectKey}`);
  }
  console.log(`[完成] ${localDir} -> MinIO${keyPrefix ? ` (${keyPrefix}/)` : ""}`);
}

async function main() {
  await migrateDir(getPath("skills"), "");
  await migrateDir(getPath("assets"), "");
  await migrateDir(getPath("web"), "web");
  console.log("全部迁移完成");
}

main().catch((e) => {
  console.error("迁移失败:", e);
  process.exit(1);
});
