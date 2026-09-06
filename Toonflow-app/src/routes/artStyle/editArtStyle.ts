import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { decodeBase64 } from "@/utils/binary";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    fileUrl: z.string(),
    prompt: z.string(),
  }),
  async (req, res) => {
    const { id, name, fileUrl, prompt } = req.body;
    const imagePath = `/artStyle/${uuidv4()}.jpg`;
    await u.oss.writeFile(imagePath, decodeBase64(fileUrl, "图片").buffer);
    await u
      .db("o_artStyle")
      .update({
        name,
        fileUrl: imagePath,
        label: name,
        prompt,
      })
      .where("id", id);
    res.status(200).send(success("艺术风格编辑成功"));
  },
);
