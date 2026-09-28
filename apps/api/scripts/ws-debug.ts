/** WS 实时路由调试：全帧日志 */
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { MockASRProvider, MockLLMProvider, MockTTSProvider, TaskRouter } from "@sema/ai-core";
import { buildApp } from "../src/app.js";

async function main(): Promise<void> {
  const app = await buildApp({
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
  await app.inject({ method: "POST", url: "/v1/wallet/ws_user/grant", payload: { cents: 300000, reason: "调试" } });

  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/realtime`);
  ws.on("message", (data, isBinary) => {
    if (isBinary) console.log("← 二进制", (data as Buffer).length, "字节");
    else console.log("← JSON", (data as Buffer).toString().slice(0, 160));
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "start", userId: "ws_user", scenarioId: "coffee-order" }));
  await new Promise((r) => setTimeout(r, 200));

  const loud = Buffer.alloc(120 * 32);
  for (let i = 0; i < loud.length / 2; i += 1) loud.writeInt16LE(Math.round(Math.sin(i / 3) * 9000), i * 2);
  console.log("── 发送语音段");
  ws.send(loud);
  ws.send(Buffer.alloc(100 * 32));
  await new Promise((r) => setTimeout(r, 1500));

  ws.send(JSON.stringify({ type: "end" }));
  await new Promise((r) => setTimeout(r, 500));
  app.close();
  process.exit(0);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
