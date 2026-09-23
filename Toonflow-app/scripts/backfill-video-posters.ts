/**
 * 存量视频封面回填：为已完成视频补抽海报到 MinIO smallImage 缓存（幂等，已有海报跳过）。
 * 用法（宿主机）：cd Toonflow-app && 加载 docker/.env 环境变量后 npx tsx scripts/backfill-video-posters.ts
 * 依赖宿主机安装 ffmpeg；Docker 镜像已内置，也可在容器内执行。
 */
import u from "@/utils";
import { ensureVideoPoster } from "@/utils/image";
import path from "node:path";

async function main() {
  // o_video.state 是中文词表（生成成功/已完成/生成失败），有 filePath 且非失败态的才需要海报
  const rows = await u.db("o_video")
    .whereNotNull("filePath")
    .whereNot("state", "生成失败")
    .select("id", "filePath");
  let ok = 0;
  let skip = 0;
  let fail = 0;
  for (const row of rows) {
    if (!row.filePath) continue;
    const key = row.filePath;
    const ext = path.extname(key);
    if (![".mp4", ".mov", ".webm", ".m4v"].includes(ext.toLowerCase())) continue;
    const base = path.basename(key, ext);
    const dir = path.dirname(key);
    const posterKey = `smallImage${dir}/${base}_poster.jpg`;
    const poster = await ensureVideoPoster(key, posterKey);
    if (poster) {
      ok += 1;
      console.log(`✅ ${poster.length > 1024 ? (poster.length / 1024).toFixed(0) + "KB" : poster.length + "B"} ${posterKey}`);
    } else if (await u.oss.fileExists(posterKey)) {
      skip += 1;
    } else {
      fail += 1;
      console.error(`❌ ${key}`);
    }
  }
  console.log(`\n回填完成：成功 ${ok}，已存在跳过 ${skip}，失败 ${fail}，共扫描 ${rows.length} 个视频`);
  process.exit(0);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
