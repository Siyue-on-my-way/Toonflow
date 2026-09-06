import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields, requireRole } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  requireRole("admin", "只有管理员才能配置内置 Agent 的 Key"),
  validateFields({
    key: z.string().optional(),
  }),
  async (req, res) => {
    const userId = (req as any).user.id;
    const { key } = req.body;
    const vendorConfigData = await u.db("o_vendorConfig").where("id", "toonflow").first();
    if (!vendorConfigData) return res.status(500).send(error("未找到该供应商配置"));

    const inputValue = JSON.parse(vendorConfigData.inputValues ?? "{}");
    inputValue.apiKey = u.crypto.encrypt(key ?? "");
    const enabledModels = new Set<string>(await u.vendor.getEnabledModelNames("toonflow"));
    enabledModels.add("claude-haiku-4-5-20251001");

    await u.db("o_vendorConfig")
      .where("id", "toonflow")
      .update({
        enable: 1,
        inputValues: JSON.stringify(inputValue),
        enabledModels: JSON.stringify([...enabledModels]),
      });
    try {
      const resText = await u.Ai.Text(`toonflow:claude-haiku-4-5-20251001`, userId).invoke({
        prompt: "1+1等于几？,请直接回答2，不要解释",
      });
      if (resText.text) {
        enabledModels.add("claude-sonnet-4-6");
        await u.vendor.setEnabledModelNames("toonflow", [...enabledModels]);

        await u.db("o_agentDeploy").where("key", "scriptAgent").update({
          model: "claude-sonnet-4-6",
          modelName: "toonflow:claude-sonnet-4-6",
          vendorId: "toonflow",
        });
        await u.db("o_agentDeploy").where("key", "productionAgent").update({
          model: "claude-sonnet-4-6",
          modelName: "toonflow:claude-sonnet-4-6",
          vendorId: "toonflow",
        });
        await u.db("o_agentDeploy").where("key", "universalAi").update({
          model: "claude-haiku-4-5",
          modelName: "toonflow:claude-haiku-4-5-20251001",
          vendorId: "toonflow",
        });
        res.status(200).send(success("一键填入成功"));
      }
    } catch (err) {
      console.error(err);
      inputValue.apiKey = "";
      await u.db("o_vendorConfig")
        .where("id", "toonflow")
        .update({ inputValues: JSON.stringify(inputValue) });
      res.status(400).send(error("KEY无效，请重新输入"));
    }
  },
);
