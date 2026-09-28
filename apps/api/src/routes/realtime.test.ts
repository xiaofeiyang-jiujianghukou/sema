import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockASRProvider, MockTTSProvider, TaskRouter, MockLLMProvider } from "@sema/ai-core";
import { SIGNUP_GRANT_CENTS } from "@sema/shared";
import { buildApp } from "../app.js";

let app: FastifyInstance;
let wsUrl = "";

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
      asr: new MockASRProvider([["Hi Ben", "Hi Ben"], ["To go please", "To go please"]]),
      tts: new MockTTSProvider(0.05, 4, 5),
    },
    router: new TaskRouter({
      flagship: new MockLLMProvider("mock-flagship", () => "Sure thing — anything else?"),
      cheap: new MockLLMProvider("mock-cheap"),
    }),
    vad: { rmsThreshold: 500, minSpeechFrames: 2, hangoverFrames: 3 },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/v1/realtime`;
  await app.inject({
    method: "POST",
    url: "/v1/wallet/ws_user/grant",
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

    ws.send(JSON.stringify({ type: "start", userId: "ws_user", scenarioId: "coffee-order" }));
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

  it("未知情景下发 error 帧（code=SCENARIO_NOT_FOUND）", async () => {
    const ws = await connect(wsUrl);
    ws.send(JSON.stringify({ type: "start", userId: "ws_user", scenarioId: "nope" }));
    const error = await waitFor(ws, "error");
    expect(error.code).toBe("SCENARIO_NOT_FOUND");
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
