import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import libtvBinding from "@/utils/libtvBinding";
import { z } from "zod";

const router = express.Router();

// 用户自助：方案 B 保底路径——粘贴 credentials.json 内容绑定（本机 libtv login web 后复制文件内容）
export default router.post(
  "/",
  validateFields({
    credentials: z.string().min(10),
  }),
  async (req, res) => {
    try {
      await libtvBinding.bindCredentials((req as any).user.id, req.body.credentials);
      res.status(200).send(success({ bound: true }));
    } catch (err: any) {
      res.status(500).send(error(err?.message || "绑定失败"));
    }
  },
);
