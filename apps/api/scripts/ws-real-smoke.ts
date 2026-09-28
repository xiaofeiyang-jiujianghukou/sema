/**
 * 真实语音 WS 冒烟：默认语音供应商（.env Key → 方舟 plan 通道）
 * TTS 合成一句用户话术 → 作为上行音频 → ASR 转写 → LLM → TTS 回复
 */
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { ArkPlanTTSProvider, MockLLMProvider, TaskRouter } from "@sema/ai-core";
import { loadEnvFiles } from "../src/env.js";
import { createTestUser, TEST_SMS, TEST_CODE } from "../src/test-utils.js";
import { buildApp } from "../src/app.js";

async function main(): Promise<void> {
  // 硬超时：冒烟卡死则 90s 后自杀并打印已收帧
  setTimeout(() => {
    console.error("❌ 90s 硬超时，已收 JSON 帧:", JSON.stringify(collected));
    process.exit(2);
  }, 90_000).unref?.();
  loadEnvFiles();
  const app = await buildApp({
    // LLM 用 Mock（省成本、确定性）；语音走真实方舟
    router: new TaskRouter({
      flagship: new MockLLMProvider("mock-flagship", () => "A latte with oat milk, excellent choice! For here or to go?"),
      cheap: new MockLLMProvider("mock-cheap"),
    }),
    smsSender: TEST_SMS, smsCode: () => TEST_CODE,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  const smokeUser = await createTestUser(app);
  await app.inject({ method: "POST", url: `/v1/wallet/grant?userId=${smokeUser.userId}`, payload: { cents: 100000, reason: "真实语音冒烟" } });

  // 先合成「用户要说的话」（真实 TTS）， vad 断句由服务端完成
  const key = process.env.SEMA_LLM_API_KEY ?? "";
  const tts = new ArkPlanTTSProvider({ apiKey: key, speaker: "zh_female_gaolengyujie_uranus_bigtts" });
  process.stdout.write("生成用户语音（真实 TTS）…");
  const userAudio: Buffer[] = [];
  for await (const chunk of tts.synthesize("Hi Ben could I get a latte please", { format: "pcm", sampleRate: 16_000 })) {
    userAudio.push(chunk);
    process.stdout.write(".");
  }
  console.log(` ${(Buffer.concat(userAudio).length / 32000).toFixed(1)}s`);

  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/realtime`);
  const jsons: Record<string, unknown>[] = [];
  const collected = jsons; // 供硬超时打印
  let audioBytes = 0;
  ws.on("message", (data, isBinary) => {
    if (isBinary) audioBytes += (data as Buffer).length;
    else {
      const j = JSON.parse((data as Buffer).toString()) as Record<string, unknown>;
      jsons.push(j);
      if (j.type === "reply") console.log(`← reply: "${j.reply}" (计费 ${j.chargedCents}厘, 余额 ${j.balanceCredits})`);
      else if (j.type === "user-utterance") console.log(`← user-utterance: "${j.text}"`);
      else if (j.type === "error") console.log(`← error: ${JSON.stringify(j).slice(0, 200)}`);
      else console.log(`← ${j.type}`);
    }
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "start", token: smokeUser.token, scenarioId: "coffee-order" }));
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (jsons.some((j) => j.type === "audio-end")) { clearInterval(t); resolve(); }
    }, 50);
  });

  console.log("── 上行用户语音（100ms 分片，真实节奏）");
  const userPcm = Buffer.concat(userAudio);
  for (let off = 0; off < userPcm.length; off += 3200) {
    ws.send(userPcm.subarray(off, Math.min(off + 3200, userPcm.length)));
    await new Promise((r) => setTimeout(r, 100));
  }
  // 静音 500ms 触发出段
  ws.send(Buffer.alloc(16000));
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (jsons.some((j) => j.type === "audio-end" && jsons.indexOf(j) > 2)) { clearInterval(t); resolve(); }
      else if (Date.now() - start > 30000) { clearInterval(t); reject(new Error("等回复音频超时")); }
    }, 100);
  });

  ws.send(JSON.stringify({ type: "end" }));
  await new Promise((r) => setTimeout(r, 800));
  const ended = jsons.find((j) => j.type === "ended");
  console.log(`← ended: ${JSON.stringify(ended?.turns ?? ended)} 轮, 音频下行 ${(audioBytes / 32000).toFixed(1)}s`);
  const utterance = jsons.find((j) => j.type === "user-utterance");
  const ok = !!utterance && /latte/i.test(String(utterance.text)) && audioBytes > 32000;
  console.log(ok ? "✅ 真实 WS 语音冒烟通过" : "❌ 冒烟未达标");
  app.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e: unknown) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
