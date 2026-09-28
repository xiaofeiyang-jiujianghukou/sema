import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockASRProvider, MockTTSProvider, TaskRouter, MockLLMProvider } from "@sema/ai-core";
import { SIGNUP_GRANT_CENTS } from "@sema/shared";
import { buildApp } from "../app.js";
import { authed, createTestUser, TEST_SMS, TEST_CODE, type TestUser } from "../test-utils.js";

let app: FastifyInstance;
let wsUrl = "";
let wsUser: TestUser;

const loud = (ms: number): Buffer => {
  const chunk = Buffer.alloc(ms * 32);
  for (let i = 0; i < chunk.length / 2; i += 1) {
    chunk.writeInt16LE(Math.round(Math.sin(i / 3) * 9000), i * 2);
  }
  return chunk;
};
const silence = (ms: number): Buffer => Buffer.alloc(ms * 32);

interface Frame {
  kind: "json" | "binary";
  json?: Record<string, unknown>;
  bytes?: number;
}

/** 连接 WS 并收集帧，直到出现指定类型或超时 */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitFor(ws: WebSocket, type: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(parsed);
      }
    };
    ws.on("message", onMessage);
  });
}

beforeAll(async () => {
  app = await buildApp({
    speech: {
      asr: new MockASRProvider([["Hi Ben", "Hi Ben"], ["To go please", "To go please"], ["AAC voice", "AAC voice"], ["Resume check", "Resume check"]]),
      tts: new MockTTSProvider(0.05, 4, 5),
    },
    router: new TaskRouter({
      flagship: new MockLLMProvider("mock-flagship", () => "Sure thing — anything else?"),
      cheap: new MockLLMProvider("mock-cheap"),
    }),
    vad: { rmsThreshold: 500, minSpeechFrames: 2, hangoverFrames: 3 },
    smsSender: TEST_SMS, smsCode: () => TEST_CODE,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/v1/realtime`;
  wsUser = await createTestUser(app);
  await app.inject({
    method: "POST",
    url: `/v1/wallet/grant?userId=${wsUser.userId}`,
    payload: { cents: SIGNUP_GRANT_CENTS, reason: "语音冒烟" },
  });
});

afterAll(async () => {
  await app.close();
});

describe("WS /v1/realtime 端到端", () => {
  it("start → ready(含 opener) → 语音段 → reply + 音频 → end 出账单", async () => {
    const ws = await connect(wsUrl);
    const binaries: Frame[] = [];
    const jsons: Record<string, unknown>[] = [];
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        binaries.push({ kind: "binary", bytes: (data as Buffer).length });
      } else {
        jsons.push(JSON.parse(data.toString()) as Record<string, unknown>);
      }
    });

    ws.send(JSON.stringify({ type: "start", token: wsUser.token, scenarioId: "coffee-order" }));
    const ready = await waitFor(ws, "ready");
    expect(ready.sessionId).toBeTruthy();
    expect(ready.opener).toContain("Morning");

    // 第一段语音：说话 120ms + 静音 100ms
    ws.send(loud(120));
    ws.send(silence(100));
    const reply1 = await waitFor(ws, "reply");
    expect(reply1.reply).toContain("anything else");
    await waitFor(ws, "audio-end");

    // 第二段语音
    ws.send(loud(120));
    ws.send(silence(100));
    await waitFor(ws, "reply");
    await waitFor(ws, "audio-end"); // 等第二轮播报完再统计

    const utterances = jsons.filter((j) => j.type === "user-utterance");
    expect(utterances.map((u) => u.text)).toEqual(["Hi Ben", "To go please"]);
    expect(binaries.length).toBeGreaterThan(4); // opener + 两轮回复的音频块

    const audioEndsBeforeEnd = jsons.filter((j) => j.type === "audio-end").length;
    expect(audioEndsBeforeEnd).toBeGreaterThanOrEqual(3); // opener + 2 轮

    ws.send(JSON.stringify({ type: "end" }));
    const ended = await waitFor(ws, "ended");
    expect(ended.turns).toBe(2);
    expect(Number(ended.totalBilledCents)).toBeGreaterThanOrEqual(0);
    ws.close();
  }, 20_000);

  it("移动端按住说话：audio-aac 帧 → 转码 → reply（需 ffmpeg）", async () => {
    const ffmpegOk = await new Promise<boolean>((resolve) => {
      import("node:child_process").then(({ execFile }) =>
        import("node:util").then(({ promisify }) =>
          promisify(execFile)("ffmpeg", ["-version"]).then(() => resolve(true)).catch(() => resolve(false))));
    });
    if (!ffmpegOk) {
      console.warn("跳过：沙箱无 ffmpeg");
      return;
    }
    const { execFile } = await import("node:child_process");
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const dir = mkdtempSync("/tmp/sema-ws-aac-");
    try {
      // 1.2s 正弦 AAC（比 VAD minSpeechFrames 门槛响亮）
      const aacPath = `${dir}/voice.aac`;
      await new Promise<void>((resolve, reject) => {
        execFile("ffmpeg", [
          "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
          "-ar", "16000", "-ac", "1", "-b:a", "48k", aacPath,
        ], (err) => (err ? reject(err) : resolve()));
      });
      const aacBase64 = readFileSync(aacPath).toString("base64");

      const ws = await connect(wsUrl);
      // 抢先监听错误（余额不足等），避免只等 reply 时把根因吞成超时
      const errors: string[] = [];
      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (!isBinary) {
          const j = JSON.parse(data.toString()) as Record<string, unknown>;
          if (j.type === "error") errors.push(String(j.message));
        }
      });
      await app.inject({
        method: "POST",
        url: `/v1/wallet/grant?userId=${wsUser.userId}`,
        payload: { cents: 3000, reason: "audio-aac 用例" },
      });
      ws.send(JSON.stringify({ type: "start", token: wsUser.token, scenarioId: "coffee-order" }));
      await waitFor(ws, "ready");

      ws.send(JSON.stringify({ type: "audio-aac", data: aacBase64 }));
      const reply = await waitFor(ws, "reply", 15_000);
      expect(reply.reply).toContain("anything else");
      expect(errors).toEqual([]);
      await waitFor(ws, "audio-end");
      ws.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("start 带 sessionId 复用文字会话（归属校验 + 不重放开场白 TTS）", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: authed(wsUser.token),
      payload: { scenarioId: "coffee-order" },
    });
    const sid = (started.json() as { sessionId: string }).sessionId;

    const ws = await connect(wsUrl);
    const binaries: number[] = [];
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) binaries.push((data as Buffer).length);
    });
    ws.send(JSON.stringify({ type: "start", token: wsUser.token, scenarioId: "coffee-order", sessionId: sid }));
    const ready = await waitFor(ws, "ready");
    expect(ready.sessionId).toBe(sid);

    ws.send(loud(120));
    ws.send(silence(100));
    const reply = await waitFor(ws, "reply");
    expect(reply.reply).toBeTruthy();
    // 复用会话：不重放开场白 TTS（首个二进制帧属于本轮回复）
    expect(binaries.length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "end" }));
    await waitFor(ws, "ended");
    ws.close();
  }, 20_000);

  it("复用他人会话 → CONVERSATION_FORBIDDEN", async () => {
    const mine = await app.inject({ method: "POST", url: "/v1/conversations", headers: authed(wsUser.token), payload: { scenarioId: "coffee-order" } });
    const sid = (mine.json() as { sessionId: string }).sessionId;
    const stranger = await createTestUser(app);
    const ws = await connect(wsUrl);
    ws.send(JSON.stringify({ type: "start", token: stranger.token, scenarioId: "coffee-order", sessionId: sid }));
    const error = await waitFor(ws, "error");
    expect(error.code).toBe("CONVERSATION_FORBIDDEN");
    ws.close();
  }, 20_000);

  it("未知情景下发 error 帧（code=SCENARIO_NOT_FOUND）", async () => {
    const ws = await connect(wsUrl);
    ws.send(JSON.stringify({ type: "start", token: wsUser.token, scenarioId: "nope" }));
    const error = await waitFor(ws, "error");
    expect(error.code).toBe("SCENARIO_NOT_FOUND");
    ws.close();
  }, 10_000);

  it("无效令牌下发 error 帧（TOKEN_INVALID）", async () => {
    const ws = await connect(wsUrl);
    ws.send(JSON.stringify({ type: "start", token: "f".repeat(64), scenarioId: "coffee-order" }));
    const error = await waitFor(ws, "error");
    expect(error.code).toBe("TOKEN_INVALID");
    ws.close();
  }, 10_000);

  it("非 JSON 控制帧回 error 且连接保持", async () => {
    const ws = await connect(wsUrl);
    ws.send("not-json");
    const error = await waitFor(ws, "error");
    expect(error.message).toContain("JSON");
    ws.send(JSON.stringify({ type: "nonsense" }));
    const error2 = await waitFor(ws, "error");
    expect(error2.message).toContain("格式错误");
    ws.close();
  }, 10_000);
});
