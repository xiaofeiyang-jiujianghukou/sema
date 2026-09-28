/**
 * 语音 Provider 抽象——与 LLMProvider 同构的设计
 *
 * 业务代码（会话/实时路由）只面向这两个接口；方舟 plan 通道适配器、
 * Mock、未来的其他供应商（如百炼语音）都实现同一契约。
 */

export interface SynthesisOptions {
  /** 音色（方舟 seed-tts-2.0 音色名） */
  speaker?: string;
  /** 音频格式：pcm（实时管线默认，16k s16le mono）或 mp3（存档/回听） */
  format?: "pcm" | "mp3";
  /** 采样率 */
  sampleRate?: number;
  /** 打断信号：barge-in 时中止合成 */
  signal?: AbortSignal;
}

export interface TTSProvider {
  readonly id: string;
  readonly model: string;
  /** 文本 → 音频块流（顺序播放即完整语音） */
  synthesize(text: string, options?: SynthesisOptions): AsyncIterable<Buffer>;
}

export interface ASRSegment {
  text: string;
  /** true = 该段已定稿（可交给 LLM）；false = 中间结果（可上屏） */
  definite: boolean;
}

export interface StreamingRecognizer {
  /** 推入音频分片（pcm 16k s16le mono） */
  push(chunk: Buffer): Promise<void>;
  /** 音频流结束，等待尾包识别结果 */
  finish(): Promise<void>;
  /** 中途放弃（barge-in / 连接关闭） */
  abort(): void;
  /** 识别结果流（partial 与 definite 混排） */
  results(): AsyncIterable<ASRSegment>;
}

export interface RecognizerOptions {
  sampleRate?: number;
  signal?: AbortSignal;
}

export interface ASRProvider {
  readonly id: string;
  readonly model: string;
  createRecognizer(options?: RecognizerOptions): StreamingRecognizer;
}
