import express from "express";
import { success, error } from "@/lib/responseFormat";
import { requireRole } from "@/middleware/middleware";
import libtvImport from "@/utils/libtvImport";

const router = express.Router();

// 模型目录桥（admin）：`libtv model search` 全量同步 LibTV 模型目录进协议目录。
// 同步条目默认不启用（不动 enabledModels），管理员在设置页按「差集」逐个启用——
// 能官方直连的模型一律走直连渠道，LibTV 只承接差集模型。
export default router.post("/", requireRole("admin", "只有管理员才能同步模型目录"), async (req, res) => {
  try {
    const result = await libtvImport.syncModelCatalog((req as any).user.id);
    res.status(200).send(success(result));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "同步模型目录失败"));
  }
});
