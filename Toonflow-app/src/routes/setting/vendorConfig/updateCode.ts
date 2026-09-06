import express from "express";
import { error } from "@/lib/responseFormat";
const router = express.Router();

export default router.post("/", async (req, res) => {
  res.status(403).send(error("系统已升级为静态代码架构，禁止动态修改供应商代码。请通过提交代码的方式修改。"));
});
