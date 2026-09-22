import express from "express";
import { success, error } from "@/lib/responseFormat";
import libtvBinding from "@/utils/libtvBinding";

const router = express.Router();

// 用户自助：检查已绑定的 LibTV 凭据是否仍有效（account info）
export default router.post("/", async (req, res) => {
  try {
    const result = await libtvBinding.checkBindingHealth((req as any).user.id);
    res.status(200).send(success(result));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "检查失败"));
  }
});
