// 登录用户角色相关的小工具。渠道 Key / 模型启用现在是全局配置，仅 admin 可写（见 SIY-65），
// 前端据此隐藏/禁用非 admin 用户碰不到的操作入口。
export function getRole(): string {
  return localStorage.getItem("role") ?? "";
}

export function isAdmin(): boolean {
  return getRole() === "admin";
}
