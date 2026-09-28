import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { authed, createTestUser, TEST_SMS, TEST_CODE, type TestUser } from "../test-utils.js";

let clockMs = Date.now();
function appOpts() {
  return { smsSender: TEST_SMS, smsCode: () => TEST_CODE, now: () => clockMs };
}

describe("认证：注册 / 密码登录 / 验证码登录 / 会话", () => {
  it("注册 → me → 改昵称 → 登出 → 令牌失效", async () => {
    const app = await buildApp(appOpts());
    const user = await createTestUser(app);

    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: authed(user.token) });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { phone: string }).phone).toBe(user.phone);
    expect((me.json() as { nickname: string }).nickname).toBe(user.nickname);

    const patched = await app.inject({ method: "PATCH", url: "/v1/auth/me", headers: authed(user.token), payload: { nickname: "小明", targetLang: "ja" } });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { nickname: string }).nickname).toBe("小明");
    expect((patched.json() as { targetLang: string }).targetLang).toBe("ja");

    await app.inject({ method: "POST", url: "/v1/auth/logout", headers: authed(user.token) });
    const after = await app.inject({ method: "GET", url: "/v1/auth/me", headers: authed(user.token) });
    expect(after.statusCode).toBe(401);

    await app.close();
  });

  it("密码登录：正确密码通过，错误密码 400", async () => {
    const app = await buildApp(appOpts());
    const user: TestUser = await createTestUser(app);

    const ok = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { phone: user.phone, password: "Passw0rd!test" } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { user: { id: string } }).user.id).toBe(user.userId);

    const bad = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { phone: user.phone, password: "wrong-password" } });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe("PASSWORD_WRONG");

    await app.close();
  });

  it("验证码登录：register 用途验证码不能用于 login；login 用途可以", async () => {
    const app = await buildApp(appOpts());
    const user = await createTestUser(app);

    // register 用途的码已被消费/用途不符
    const wrongPurpose = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { phone: user.phone, code: TEST_CODE } });
    expect(wrongPurpose.statusCode).toBe(400);

    // 未注册手机号申请 login 验证码可以发，但登录时账号不存在
    const other = await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: "13900001111", purpose: "login" } });
    expect(other.statusCode).toBe(200);
    const ghost = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { phone: "13900001111", code: TEST_CODE } });
    expect(ghost.statusCode).toBe(400);
    expect((ghost.json() as { error: string }).error).toBe("USER_NOT_FOUND");

    // 已注册用户：冷却期过后申请 login 验证码 → 登录成功
    clockMs += 61_000;
    const other2 = await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: user.phone, purpose: "login" } });
    expect(other2.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { phone: user.phone, code: TEST_CODE } });
    expect(login.statusCode).toBe(200);
    expect((login.json() as { user: { phone: string } }).user.phone).toBe(user.phone);

    // 验证码一次性：同一码第二次登录失败
    const replay = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { phone: user.phone, code: TEST_CODE } });
    expect(replay.statusCode).toBe(400);

    await app.close();
  });

  it("验证码限流：60s 冷却 + 重复注册拦截", async () => {
    const app = await buildApp(appOpts());
    const user = await createTestUser(app);

    // 冷却期内再发 → 429
    const hot = await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: user.phone, purpose: "login" } });
    expect(hot.statusCode).toBe(429);

    // 已注册手机号申请注册验证码 → 先撞冷却，冷却过后暴露 PHONE_TAKEN
    const taken = await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: user.phone, purpose: "register" } });
    expect(taken.statusCode).toBe(429);
    clockMs += 61_000;
    const taken2 = await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: user.phone, purpose: "register" } });
    expect(taken2.statusCode).toBe(409);

    // 换号验证 PHONE_TAKEN
    const first = await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: "13900002222", purpose: "register" } });
    expect(first.statusCode).toBe(200);
    const reg = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { phone: "13900002222", code: TEST_CODE, password: "Passw0rd!test" } });
    expect(reg.statusCode).toBe(201);
    clockMs += 61_000; // 跳出冷却，暴露"手机号已注册"
    const again = await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: "13900002222", purpose: "register" } });
    expect(again.statusCode).toBe(409);

    await app.close();
  });

  it("未登录访问业务路由 → 401；伪造令牌 → 401", async () => {
    const app = await buildApp(appOpts());

    const noAuth = await app.inject({ method: "POST", url: "/v1/conversations", payload: { scenarioId: "coffee-order" } });
    expect(noAuth.statusCode).toBe(401);

    const fake = await app.inject({ method: "POST", url: "/v1/conversations", headers: authed("deadbeef".repeat(4)), payload: { scenarioId: "coffee-order" } });
    expect(fake.statusCode).toBe(401);

    const me401 = await app.inject({ method: "GET", url: "/v1/stats" });
    expect(me401.statusCode).toBe(401);

    await app.close();
  });
});
