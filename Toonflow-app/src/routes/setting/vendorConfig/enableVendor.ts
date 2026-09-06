import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields, requireRole } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
const router = express.Router();
export default router.post(
  "/",
  requireRole("admin", "只有管理员才能启用/停用渠道"),
  validateFields({
    id: z.string(),
    enable: z.number(),
  }),
  async (req, res) => {
    const { id, enable } = req.body;
    await u.db("o_vendorConfig").where("id", id).update({ enable });
    res.status(200).send(success("更新成功"));
  },
);
