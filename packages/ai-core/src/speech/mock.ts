/**
 * Mock 语音供应商——零成本跑通实时语音管线全链路（开发/测试）
 *
 * - MockTTS：按文本长度生成可播放的 PCM（轻正弦波 + 静音），分块产出，
 *   模拟流式行为；signal 中止即刻停止。
 * - MockASR：忽略音频内容，按脚本 FIFO 吐出识别结果——测试里"说什么"由脚本决定。
 */
import { ASRSegment, type ASRProvider, type RecognizerOptions, type StreamingRecognizer, type SynthesisOptions, type TTSProvider } from "./types.js";

const SAMPLE_RATE = 16_000;

function toneChunk(seconds: number, charSeed: number): Buffer {
  const samples = Math.floor(SAMPLE_RATE * seconds);
  const buffer = Buffer.alloc(samples * 2);
  const freq = 220 + (charSeed % 8) * 55;
  for (let i = 0; i < samples; i += 1) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.min(1, i / 200, (samples - i) / 200);
    const value = Math.sin(2 * Math.PI * freq * t) * 6000 * envelope;
    buffer.writeInt16LE(Math.round(value), i * 2);
  }
  return buffer;
}

export class MockTTSProvider implements TTSProvider {
  readonly id = "mock-tts";
  readonly model = "mock-tts";

  /**
   * @param chunkSeconds 单块音频时长（秒）
   * @param chunkCount 块数
   * @param delayMs 每块间人为延迟——给 barge-in 测试制造播报时间窗
   */
  constructor(
    private readonly chunkSeconds = 0.2,
    private readonly chunkCount = 3,
    private readonly delayMs = 0,
  ) {}

  async *synthesize(text: string, options?: SynthesisOptions): AsyncIterable<Buffer> {
    if (options?.signal?.aborted) return;
    const chars = Math.max(1, text.replace(/\s/g, "").length);
    for (let i = 0; i < this.chunkCount; i += 1) {
      if (options?.signal?.aborted) return;
      // 语速与文本长度挂钩，测试可断言音频量
      const seconds = Math.min(0.4, (chars / 20) * this.chunkSeconds);
      yield toneChunk(seconds, chars + i);
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
    }
  }
}

export class MockASRProvider implements ASRProvider {
  readonly id = "mock-asr";
  readonly model = "mock-asr";

  /**
   * @param script 每次 createRecognizer 出队一个条目；
   * 条目可以是单个文本，或 [partial, definite] 数组。
   */
  constructor(private readonly script: Array<string | [string, string]> = []) {}

  createRecognizer(_options?: RecognizerOptions): StreamingRecognizer {
    const next = this.script.shift();
    // 语义对齐真实 ASR：partial 随音频流出现；definite 只在 finish() 后出现
    let finalSegment: ASRSegment;
    const ready: ASRSegment[] = [];
    if (next === undefined) {
      finalSegment = { text: "", definite: true };
    } else if (Array.isArray(next)) {
      ready.push({ text: next[0], definite: false });
      finalSegment = { text: next[1], definite: true };
    } else {
      finalSegment = { text: next, definite: true };
    }
    let done = false;
    let waiters: Array<(r: IteratorResult<ASRSegment>) => void> = [];

    const wake = (): void => {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: ready.shift() as ASRSegment, done: false });
    };

    return {
      async push() {
        /* Mock 不听音频内容 */
      },
      async finish() {
        if (!done) {
          done = true;
          ready.push(finalSegment);
          wake();
        }
      },
      abort() {
        done = true;
        for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
      },
      async *results() {
        while (true) {
          if (ready.length > 0) {
            yield ready.shift() as ASRSegment;
            continue;
          }
          if (done) return;
          const result = await new Promise<IteratorResult<ASRSegment>>((resolve) => {
            waiters.push(resolve);
          });
          if (result.done) return;
          yield result.value;
        }
      },
    };
  }
}
