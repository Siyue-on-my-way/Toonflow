import express from "express";
import { success, error } from "@/lib/responseFormat";
import libtvImport from "@/utils/libtvImport";

const router = express.Router();

// 用户自助：「从 LibTV 导入」第一步——列出我名下的画布项目（只读，不在 LibTV 侧写任何东西）
export default router.post("/", async (req, res) => {
  try {
    const projects = await libtvImport.listUserProjects((req as any).user.id);
    res.status(200).send(success(projects));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "获取画布项目列表失败"));
  }
});
