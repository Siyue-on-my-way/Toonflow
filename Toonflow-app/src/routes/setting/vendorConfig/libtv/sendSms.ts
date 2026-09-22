import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import libtvBinding from "@/utils/libtvBinding";
import { z } from "zod";

const router = express.Router();

// 用户自助：绑定 LibTV 账号第一步——发送短信验证码（方案 A）
export default router.post(
  "/",
  validateFields({
    phone: z.string().regex(/^1\d{10}$/, "需要 11 位中国大陆手机号"),
  }),
  async (req, res) => {
    try {
      await libtvBinding.sendSms((req as any).user.id, req.body.phone);
      res.status(200).send(success("验证码已发送"));
    } catch (err: any) {
      res.status(500).send(error(err?.message || "验证码发送失败"));
    }
  },
);
