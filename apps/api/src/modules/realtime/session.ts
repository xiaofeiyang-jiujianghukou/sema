/**
 * 实时语音会话编排：把「用户声音 → LLM → AI 声音」整条回路接起来
 *
 * 职责（WS 路由只做传输，这里做所有决策）：
 * 1. VAD 断句：对上行 PCM 做能量检测——说话能量越阈即开始，静音超过
 *    hangover 即认为一句话结束，产出语音段
 * 2. 语音段 → ASR → 文本 → ConversationService.turn()（计费、对话、
 *    成本计量全部复用 M1 已验证的领域服务）
 * 3. LLM 回复 → TTS → 音频分片，经 emit 回传客户端
 * 4. Barge-in：用户开口即置 interrupt——中止正在播报的 TTS 与进行中的
 *    turn，新语音段立刻接管（对话不许 AI 抢话）
 */
import type WebSocket from "ws";
import type { ASRProvider, TTSProvider } from "@sema/ai-core";
import type { ConversationService } from "../conversation/service.js";

/** 16k s16le mono：1 字节 = 1/32768 秒 */
const BYTES_PER_MS = 32;

export interface VADOptions {
  /** RMS 能量阈值（s16le 满幅 32767，环境噪声一般 < 300） */
  rmsThreshold?: number;
  /** 判定「开口」所需连续语音帧（每帧 20ms） */
  minSpeechFrames?: number;
  /** 判定「说完」所需连续静音帧 */
  hangoverFrames?: number;
  /** 单段语音上限（毫秒），防止环境长噪声撑爆 ASR */
  maxSegmentMs?: number;
}

export interface RealtimeCallbacks {
  /** AI 开始回复（客户端可提示并准备接收音频） */
  onReplyStart?: (userText: string) => void;
  /** AI 文本回复 + 本次计费信息（音频可能在后续到达） */
  onReply: (info: { reply: string; chargedCents: number; balanceCredits: string }) => void;
  /** TTS 音频分片（PCM 16k mono s16le） */
  onAudioChunk: (chunk: Buffer) => void;
  /** AI 本轮播报完毕 */
  onReplyEnd?: () => void;
  /** 发生错误（连接保持，会话可继续） */
  onError: (message: string) => void;
  /** 用户说了什么（转写定稿） */
  onUserUtterance?: (text: string) => void;
}

export class RealtimeVoiceSession {
  private readonly vad: Required<VADOptions>;
  private ringBuffer: Buffer = Buffer.alloc(0);
  private speechFrames = 0;
  private silenceFrames = 0;
  private inSegment = false;
  /** 播报中（用户开口即打断） */
  private speaking = false;
  private abortController: AbortController | null = null;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly sessionId: string,
    private readonly conversations: ConversationService,
    private readonly asr: ASRProvider,
    private readonly tts: TTSProvider,
    private readonly callbacks: RealtimeCallbacks,
    vadOptions?: VADOptions,
    /** 语言参数：ASR 识别语言提示 + TTS 音色（按情景目标语言选择） */
    private readonly speechOptions?: { language?: string; speaker?: string },
  ) {
    this.vad = {
      rmsThreshold: vadOptions?.rmsThreshold ?? 700,
      // 真实语音（含 TTS 戏剧性停顿）：静音 700ms 才出段，开口需 160ms
      minSpeechFrames: vadOptions?.minSpeechFrames ?? 8,
      hangoverFrames: vadOptions?.hangoverFrames ?? 35,
      maxSegmentMs: vadOptions?.maxSegmentMs ?? 15_000,
    };
  }

  /** 上行 PCM（16k mono s16le，任意分片大小，内部按 20ms 帧切） */
  pushAudio(chunk: Buffer): void {
    if (this.closed) return;
    const frameBytes = 640; // 20ms @ 16k s16le
    for (let offset = 0; offset < chunk.length; offset += frameBytes) {
      this.processFrame(chunk.subarray(offset, Math.min(offset + frameBytes, chunk.length)));
    }
  }

  private processFrame(chunk: Buffer): void {
    const rms = this.rms(chunk);
    const isSpeech = rms >= this.vad.rmsThreshold;

    if (this.speaking && isSpeech && this.abortController) {
      // Barge-in：用户开口，立即掐断 AI
      this.abortController.abort();
      this.abortController = null;
      this.speaking = false;
      this.callbacks.onReplyEnd?.();
    }

    if (!this.inSegment) {
      if (isSpeech) {
        this.speechFrames += 1;
        this.ringBuffer = Buffer.concat([this.ringBuffer, chunk]);
        if (this.speechFrames >= this.vad.minSpeechFrames) {
          this.inSegment = true;
          this.silenceFrames = 0;
        }
      } else {
        this.speechFrames = 0;
        this.ringBuffer = Buffer.alloc(0);
      }
      return;
    }

    // 段内：全量缓存，静音累计到 hangover 即出段
    this.ringBuffer = Buffer.concat([this.ringBuffer, chunk]);
    if (isSpeech) {
      this.silenceFrames = 0;
    } else {
      this.silenceFrames += 1;
    }
    if (this.silenceFrames >= this.vad.hangoverFrames || this.ringBuffer.length >= this.vad.maxSegmentMs * BYTES_PER_MS) {
      void this.handleSegment(Buffer.from(this.ringBuffer));
      this.ringBuffer = Buffer.alloc(0);
      this.inSegment = false;
      this.speechFrames = 0;
      this.silenceFrames = 0;
    }
  }

  /** WS 关闭时调用：放弃进行中的工作 */
  close(): void {
    this.closed = true;
    this.abortController?.abort();
  }

  /** 语音段 → ASR → LLM（计费）→ TTS → 下行 */
  private async handleSegment(segment: Buffer): Promise<void> {
    if (this.closed || segment.length === 0) return;
    try {
      const text = await this.transcribe(segment);
      if (this.closed) return;
      if (text.trim().length === 0) return; // 纯噪声段，静默丢弃
      this.callbacks.onUserUtterance?.(text);

      const controller = new AbortController();
      this.abortController = controller;
      this.speaking = true;
      this.callbacks.onReplyStart?.(text);

      const turn = await this.conversations.turn(this.sessionId, text);
      if (controller.signal.aborted) return;
      this.callbacks.onReply({
        reply: turn.reply,
        chargedCents: turn.chargedCents,
        balanceCredits: turn.balanceCredits,
      });

      for await (const audioChunk of this.tts.synthesize(turn.reply, {
        format: "pcm",
        sampleRate: 16_000,
        ...(this.speechOptions?.speaker ? { speaker: this.speechOptions.speaker } : {}),
        signal: controller.signal,
      })) {
        if (controller.signal.aborted || this.closed) return;
        this.callbacks.onAudioChunk(audioChunk);
      }
      if (!controller.signal.aborted && !this.closed) {
        this.callbacks.onReplyEnd?.();
      }
      // 播报正常结束：复位状态，避免下一帧语音被误判为打断
      this.abortController = null;
      this.speaking = false;
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || /中止/.test(err.message))) return; // barge-in 自身的中止不算错误
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
    } finally {
      if (this.abortController?.signal.aborted) {
        this.abortController = null;
        this.speaking = false;
      }
    }
  }

  /** ASR：整段音频推入识别器，取最后一个定稿（无定稿则取最后非空文本） */
  private async transcribe(segment: Buffer): Promise<string> {
    const recognizer = this.asr.createRecognizer({
      sampleRate: 16_000,
      ...(this.speechOptions?.language ? { language: this.speechOptions.language } : {}),
    });
    const collecting = (async () => {
      const parts: string[] = [];
      for await (const segmentResult of recognizer.results()) {
        if (segmentResult.definite && segmentResult.text) parts.push(segmentResult.text);
      }
      return parts;
    })();

    // 以 100ms 为片推入，模拟实时节奏（服务端协议要求流式分片）
    const slice = BYTES_PER_MS * 100;
    for (let offset = 0; offset < segment.length; offset += slice) {
      await recognizer.push(segment.subarray(offset, Math.min(offset + slice, segment.length)));
    }
    await recognizer.finish();
    const parts = await collecting;
    recognizer.abort();

    if (parts.length > 0) return parts.join("");
    // 无定稿时兜底：从结果流里拿不到——整段一次性已推完，返回空
    return "";
  }

  private rms(chunk: Buffer): number {
    if (chunk.length < 2) return 0;
    let sum = 0;
    const samples = Math.floor(chunk.length / 2);
    for (let i = 0; i < samples; i += 1) {
      const value = chunk.readInt16LE(i * 2);
      sum += value * value;
    }
    return Math.sqrt(sum / samples);
  }
}
