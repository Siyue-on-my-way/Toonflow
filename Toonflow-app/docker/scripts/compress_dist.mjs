// 构建期预压缩 dist 静态资源：为每个可压缩文件生成 .br（brotli q11）和 .gz（gzip 9），
// 供 nginx 的 brotli_static / gzip_static 直接下发，省去每次请求的动态压缩开销。
// 用法：node compress_dist.mjs <dist目录>
// 注意：会先清掉目录里旧的 .br/.gz，避免构建后残留陈旧的预压缩产物。
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const root = process.argv[2];
if (!root) {
  console.error("用法: node compress_dist.mjs <dist目录>");
  process.exit(1);
}

const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".xml", ".webmanifest"]);
const MIN_SIZE = 1024; // 太小的文件压缩收益低，跳过

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, fn);
    else fn(p, st.size);
  }
}

// 1) 清理旧的预压缩产物（防止 build 换了内容哈希后 .br/.gz 残留变陈旧）
const removed = { br: 0, gz: 0 };
walk(root, (p) => {
  if (p.endsWith(".br")) { unlinkSync(p); removed.br++; }
  else if (p.endsWith(".gz")) { unlinkSync(p); removed.gz++; }
});

// 2) 生成新的预压缩产物
let totalRaw = 0, totalBr = 0, totalGz = 0, count = 0;
walk(root, (p, size) => {
  if (p.endsWith(".br") || p.endsWith(".gz")) return;
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  if (!COMPRESSIBLE.has(ext) || size < MIN_SIZE) return;

  const src = readFileSync(p);
  const br = brotliCompressSync(src, {
    params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
  });
  const gz = gzipSync(src, { level: 9 });
  writeFileSync(p + ".br", br);
  writeFileSync(p + ".gz", gz);
  count++;
  totalRaw += size;
  totalBr += br.length;
  totalGz += gz.length;
  console.log(`  ${p.replace(root + "/", "")}: ${size} -> br ${br.length} / gz ${gz.length}`);
});

const mb = (n) => (n / 1024 / 1024).toFixed(2) + "MB";
console.log(`===> 预压缩完成：${count} 个文件，原始 ${mb(totalRaw)}，brotli ${mb(totalBr)}，gzip ${mb(totalGz)}（清理旧产物 br×${removed.br} gz×${removed.gz}）`);
