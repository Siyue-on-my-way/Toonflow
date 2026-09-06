import express from "express";
import z from "zod";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import fs from "fs";
import path from "path";
import axios from "axios";
import compressing from "compressing";
import { success } from "@/lib/responseFormat";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    url: z.url(),
    reinstall: z.boolean(),
    version: z.string(),
  }),
  async (req, res) => {
    const { reinstall, url, version } = req.body;
    if (reinstall) {
      res.status(200).send(success("请在浏览器中手动下载并安装最新版本"));
    } else {
      // compressing can consume a Buffer, so the downloaded archive never
      // needs a second local file. Its extracted files are request-scoped and
      // are always removed, including when extraction/copying fails.
      const tempRoot = u.getPath(["temp"]);
      fs.mkdirSync(tempRoot, { recursive: true });
      const extractDir = fs.mkdtempSync(path.join(tempRoot, "update-"));
      try {
        const zip = await axios.get(url, { responseType: "arraybuffer" }).then((response) => Buffer.from(response.data));
        await compressing.zip.uncompress(zip, extractDir);
        const dataDir = u.getPath();
        fs.cpSync(extractDir, dataDir, { recursive: true, force: true });
        res.status(200).send(success(`更新${version}成功，5秒后重启`));
      } finally {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }
    }
  },
);
