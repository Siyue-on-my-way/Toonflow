import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

const PHONE_REGEX = /^1[3-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 自助注册：手机号/邮箱 + 两次密码，成功后角色为 member
export default router.post(
  "/",
  validateFields({
    account: z.string().refine((v) => PHONE_REGEX.test(v) || EMAIL_REGEX.test(v), {
      message: "请输入正确格式的手机号或邮箱",
    }),
    password: z.string().min(1),
    confirmPassword: z.string().min(1),
  }),
  async (req, res) => {
    const { account, password, confirmPassword } = req.body;

    if (password !== confirmPassword) {
      return res.status(400).send(error("两次输入的密码不一致"));
    }

    const existing = await u.db("o_user").where("name", "=", account).first();
    if (existing) {
      return res.status(400).send(error("该手机号/邮箱已被注册"));
    }

    const maxRow = await u.db("o_user").max("id as maxId").first();
    const id = Number(maxRow?.maxId ?? 0) + 1;
    await u.db("o_user").insert({ id, name: account, password, role: "member" });

    return res.status(200).send(success({ id, name: account, role: "member" }, "注册成功"));
  },
);
