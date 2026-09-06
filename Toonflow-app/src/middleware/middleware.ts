import { Request, Response, NextFunction } from "express";
import { z, ZodTypeAny } from "zod";

import { zhCN } from "zod/locales";
import db from "@/utils/db";

z.config(zhCN());

export function validateFields(
  shape: Record<string, ZodTypeAny>,
  source: "body" | "query" | "params" = "body", // 默认校验 body
) {
  const schema = z.object(shape);

  return (req: Request, res: Response, next: NextFunction) => {
    const data = req[source];
    const parseResult = schema.safeParse(data);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((issue) => `字段 ${issue.path.join(".")} ${issue.message}`);
      console.error(errors);
      return res.status(400).json({ message: "参数错误", errors });
    }
    next();
  };
}

// 角色校验中间件：要求当前登录账号的角色属于 roles 之一，否则 403。
// 供"编辑渠道协议目录本身"等 admin 专属接口使用（如 addVendorModelSpec/updateVendorModelSpec/deleteVendorModelSpec）；
// member 的账号自助接口（addVendorModel 等）不挂此中间件。
export function requireRole(roles: string | string[], message: string = "权限不足") {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ message: "未提供有效登录信息" });
    const user = await db("o_user").where("id", userId).first();
    if (!user || !allowedRoles.includes(user.role ?? "")) {
      return res.status(403).json({ message });
    }
    next();
  };
}
