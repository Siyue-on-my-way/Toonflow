import express from "express";
import { success, error } from "@/lib/responseFormat";
import libtvBinding from "@/utils/libtvBinding";

const router = express.Router();

// 用户自助：查询当前用户的 LibTV 绑定状态（不回显凭据）
export default router.post("/", async (req, res) => {
  try {
    const status = await libtvBinding.getBinding((req as any).user.id);
    res.status(200).send(success(status));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "查询失败"));
  }
});
