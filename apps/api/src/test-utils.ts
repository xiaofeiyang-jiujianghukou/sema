/**
 * 测试工具：注册并登录一个用户，返回令牌与 id
 */
import { FixedCodeSmsSender } from "./modules/auth/service.js";

export const TEST_SMS = new FixedCodeSmsSender("246810");
export const TEST_CODE = "246810";

export interface TestUser {
  userId: string;
  phone: string;
  token: string;
  nickname: string;
}

let counter = 0;

export async function createTestUser(app: { inject: (opts: unknown) => Promise<{ statusCode: number; json: () => unknown }> }, phone?: string): Promise<TestUser> {
  counter += 1;
  const p = phone ?? `138${String(10_000_000 + counter).slice(0, 8)}`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/request-code",
    payload: { phone: p, purpose: "register" },
  });
  if (res.statusCode !== 200) throw new Error(`request-code 失败: ${res.statusCode}`);
  const reg = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { phone: p, code: TEST_CODE, password: "Passw0rd!test", nickname: `测试用户${counter}` },
  });
  if (reg.statusCode !== 201) throw new Error(`注册失败: ${reg.statusCode}`);
  const body = reg.json() as { token: string; user: { id: string; nickname: string } };
  return { userId: body.user.id, phone: p, token: body.token, nickname: body.user.nickname };
}

export function authed(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
