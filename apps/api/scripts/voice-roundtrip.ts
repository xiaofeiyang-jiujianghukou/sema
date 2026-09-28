/**
 * 真实语音回路验证：TTS 合成 → PCM → ASR 转写
 *
 * 用你自己的声音服务验证自己的耳朵——全程真实 API，无 Mock。
 * 运行：npx tsx scripts/voice-roundtrip.ts
 */
import { ArkPlanASRProvider, ArkPlanTTSProvider } from "@sema/ai-core";
import { writeFileSync } from "node:fs";
import { loadEnv } from "./voice-env.js";

async function main(): Promise<void> {
  const { apiKey, speaker } = loadEnv();
  const text = "Hello! Could I get a latte with oat milk, please? For here.";

  // ── 1) TTS：文本 → PCM 音频 ──
  const tts = new ArkPlanTTSProvider({ apiKey, speaker });
  const chunks: Buffer[] = [];
  process.stdout.write("TTS 合成中");
  for await (const chunk of tts.synthesize(text, { format: "pcm", sampleRate: 16_000 })) {
    chunks.push(chunk);
    process.stdout.write(".");
  }
  const pcm = Buffer.concat(chunks);
  const durationSeconds = pcm.length / 2 / 16_000;
  console.log(`\n✓ 音频 ${pcm.length} 字节 ≈ ${durationSeconds.toFixed(2)} 秒 PCM(16k mono s16le)`);
  writeFileSync(new URL("./.roundtrip.pcm", import.meta.url), pcm);

  // ── 2) ASR：PCM → 文本（按 100ms 分片推入，模拟实时流） ──
  const asr = new ArkPlanASRProvider({ apiKey });
  const recognizer = asr.createRecognizer({ sampleRate: 16_000 });
  const results: Array<{ text: string; definite: boolean }> = [];
  const collecting = (async () => {
    for await (const segment of recognizer.results()) {
      results.push(segment);
      if (segment.definite) {
        process.stdout.write(`  [定稿] ${segment.text}\n`);
      }
    }
  })();

  process.stdout.write("ASR 识别中\n");
  const slice = 3_200; // 100ms @ 16k s16le
  for (let offset = 0; offset < pcm.length; offset += slice) {
    await recognizer.push(pcm.subarray(offset, Math.min(offset + slice, pcm.length)));
  }
  await recognizer.finish();
  await collecting;

  // ── 3) 判定 ──
  const finalText = results.filter((r) => r.definite).map((r) => r.text).join("") ||
    results.map((r) => r.text).join("");
  console.log(`\n最终转写: "${finalText}"`);
  const ok = /latte/i.test(finalText) && /milk/i.test(finalText);
  console.log(ok ? "✅ 回路验证通过：TTS 说的，ASR 听懂了" : "❌ 转写与原文不匹配");
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("❌ 回路失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
