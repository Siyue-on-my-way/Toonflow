import express from "express";
import { error } from "@/lib/responseFormat";
const router = express.Router();

export default router.post("/", async (req, res) => {
  res.status(403).send(error("系统已升级为静态代码架构，禁止动态添加供应商。请通过提交代码的方式新增供应商。"));
});
