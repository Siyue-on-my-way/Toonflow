import express from "express";
import { success, error } from "@/lib/responseFormat";
import libtvBinding from "@/utils/libtvBinding";

const router = express.Router();

// 用户自助：解除 LibTV 账号绑定（清空该用户的凭据记录与本地凭据文件）
export default router.post("/", async (req, res) => {
  try {
    await libtvBinding.unbind((req as any).user.id);
    res.status(200).send(success({ bound: false }));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "解绑失败"));
  }
});
