import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import libtvBinding from "@/utils/libtvBinding";
import { z } from "zod";

const router = express.Router();

// 用户自助：绑定 LibTV 账号第二步——提交短信验证码完成登录并保存凭据（方案 A）
export default router.post(
  "/",
  validateFields({
    phone: z.string().regex(/^1\d{10}$/, "需要 11 位中国大陆手机号"),
    code: z.string().regex(/^\d{6}$/, "需要 6 位数字验证码"),
  }),
  async (req, res) => {
    try {
      await libtvBinding.verifyAndSave((req as any).user.id, req.body.phone, req.body.code);
      res.status(200).send(success({ bound: true }));
    } catch (err: any) {
      res.status(500).send(error(err?.message || "登录失败"));
    }
  },
);
