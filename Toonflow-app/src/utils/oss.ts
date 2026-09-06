import { Client as MinioClient } from "minio";
import path from "node:path";
import { Readable } from "node:stream";
import { isEletron } from "@/utils/getPath";
import { decodeBase64 } from "@/utils/binary";

// 将用户传入的相对路径规范化为安全的 MinIO object key（禁止越出根目录）
function normalizeObjectKey(userPath: string): string {
  const segments = userPath
    .replace(/^[/\\]+/, "")
    .split(/[\\/]+/)
    .filter((seg) => seg !== "" && seg !== ".");
  if (segments.some((seg) => seg === "..")) {
    throw new Error(`${userPath} 路径不合法`);
  }
  return segments.join("/");
}

// 解析 OSS_ENDPOINT，兼容带/不带协议头、带/不带端口的写法
function parseEndpoint(raw: string): { endPoint: string; port?: number; useSSL?: boolean } {
  const useSSL = /^https:\/\//i.test(raw);
  const withoutScheme = raw.replace(/^https?:\/\//i, "");
  const [endPoint, portStr] = withoutScheme.split(":");
  return { endPoint, port: portStr ? Number(portStr) : undefined, useSSL };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class OSS {
  private client: MinioClient;
  private bucket: string;
  private initPromise: Promise<void>;

  constructor() {
    const { endPoint, port, useSSL } = parseEndpoint(process.env.OSS_ENDPOINT || "127.0.0.1:9000");
    this.bucket = process.env.OSS_BUCKET || "toonflow";
    this.client = new MinioClient({
      endPoint,
      port,
      useSSL: process.env.OSS_USE_SSL ? process.env.OSS_USE_SSL === "true" : !!useSSL,
      accessKey: process.env.OSS_ACCESS_KEY || "",
      secretKey: process.env.OSS_SECRET_KEY || "",
    });
    // 初始化时确保 bucket 存在
    this.initPromise = this.client
      .bucketExists(this.bucket)
      .catch(() => false)
      .then(async (exists) => {
        if (!exists) {
          await this.client.makeBucket(this.bucket);
        }
      });
  }

  /**
   * 等待 bucket 初始化完成。用于保证所有文件操作在 bucket 已确认存在后执行。
   * @private
   */
  private async ensureInit() {
    await this.initPromise;
  }

  /**
   * 获取指定相对路径文件的访问 URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件的 http 链接
   */
  async getFileUrl(userRelPath: string, prefix?: string): Promise<string> {
    if (!prefix) prefix = "oss";
    const key = normalizeObjectKey(userRelPath);
    let url = `/${prefix}/`;
    if (process.env.ossURL && process.env.ossURL !== "") url = process.env.ossURL + `/${prefix}/`;
    if (process.env.NODE_ENV == "dev") url = `http://localhost:10588/${prefix}/`;
    if (isEletron()) url = `http://localhost:${process.env.PORT}/${prefix}/`;
    return `${url}${key}`;
  }

  /**
   * 读取指定路径的文件内容为 Buffer。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件内容的 Buffer
   * @throws 路径不合法、文件不存在等错误
   */
  async getFile(userRelPath: string): Promise<Buffer> {
    await this.ensureInit();
    const key = normalizeObjectKey(userRelPath);
    const stream = await this.client.getObject(this.bucket, key);
    return streamToBuffer(stream);
  }

  /**
   * 以流的方式读取指定路径的文件（不把整个文件缓冲进内存）。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns MinIO 可读流与文件大小（来自 statObject，可用于设置 Content-Length）
   * @throws 路径不合法、文件不存在等错误
   */
  async getFileStream(userRelPath: string): Promise<{ stream: Readable; size: number }> {
    await this.ensureInit();
    const key = normalizeObjectKey(userRelPath);
    // 先 stat 再取流：文件不存在时直接抛错（由调用方返回 404），同时拿到准确的文件大小
    const stat = await this.client.statObject(this.bucket, key);
    const stream = await this.client.getObject(this.bucket, key);
    return { stream, size: stat.size };
  }

  /**
   * 读取图片文件并转换为 base64 编码的 Data URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns base64 编码的 Data URL (例如: data:image/png;base64,iVBORw0KGgo...)
   * @throws 路径不合法、文件不存在、不是图片文件等错误
   */
  async getImageBase64(userRelPath: string): Promise<string> {
    await this.ensureInit();

    // 获取文件扩展名并确定 MIME 类型
    const ext = path.extname(userRelPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
      ".mp4": "video/mp4",
      ".mp3": "audio/mpeg",
    };

    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      throw new Error(`不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(", ")}`);
    }

    // 读取文件并转换为 base64
    const data = await this.getFile(userRelPath);
    const base64 = data.toString("base64");
    // 返回完整的 Data URL
    return `data:${mimeType};base64,${base64}`;
  }

  /**
   * 删除指定路径的文件。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @throws 路径不合法、文件不存在等错误
   */
  async deleteFile(userRelPath: string): Promise<void> {
    await this.ensureInit();
    const key = normalizeObjectKey(userRelPath);
    await this.client.removeObject(this.bucket, key);
  }

  /**
   * 删除指定路径的文件夹及其所有内容。
   * @param userRelPath 用户传入的相对文件夹路径（使用 / 作为分隔符）
   * @throws 路径不合法等错误
   */
  async deleteDirectory(userRelPath: string): Promise<void> {
    await this.ensureInit();
    const prefix = normalizeObjectKey(userRelPath).replace(/\/?$/, "/");
    const objectsStream = this.client.listObjectsV2(this.bucket, prefix, true);
    const objectNames: string[] = [];
    for await (const obj of objectsStream) {
      if (obj.name) objectNames.push(obj.name);
    }
    if (objectNames.length > 0) {
      await this.client.removeObjects(this.bucket, objectNames);
    }
  }

  /**
   * 将数据写入指定路径的新文件或覆盖已有文件。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @param data 要写入的数据，可以为 Buffer、base64 字符串或 Readable 流。
   *   Readable 会直接交给 MinIO，不会先写入本地临时文件。
   * @param size 流的字节数（可选；已知时建议传入）
   * @throws 路径不合法等错误
   */
  async writeFile(userRelPath: string, data: Buffer | Uint8Array | string | Readable, size?: number): Promise<void> {
    await this.ensureInit();
    const key = normalizeObjectKey(userRelPath);
    if (typeof data === "string") {
      const buffer = decodeBase64(data).buffer;
      await this.client.putObject(this.bucket, key, buffer, buffer.length);
      return;
    }
    if (Buffer.isBuffer(data)) {
      await this.client.putObject(this.bucket, key, data, data.length);
      return;
    }
    if (data instanceof Uint8Array) {
      const buffer = Buffer.from(data);
      await this.client.putObject(this.bucket, key, buffer, buffer.length);
      return;
    }

    // MinIO accepts a Node Readable directly. This is the path for a future
    // busboy/multipart handler and keeps the request stream off local disk.
    await this.client.putObject(this.bucket, key, data, size);
  }

  /**
   * 检查指定路径文件是否存在。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件存在返回 true，否则 false
   */
  async fileExists(userRelPath: string): Promise<boolean> {
    await this.ensureInit();
    try {
      const key = normalizeObjectKey(userRelPath);
      await this.client.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取图片的缩略图 URL（当前直接返回原图 URL，附带 size 参数）。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 缩略图 URL（当前等同原图 URL）
   */
  async getSmallImageUrl(userRelPath: string): Promise<string> {
    return (await this.getFileUrl(userRelPath)) + "?size=20";
  }
}

export default new OSS();
