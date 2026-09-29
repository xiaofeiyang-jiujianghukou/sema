/**
 * 方舟 Agent/Coding Plan 语音通道适配器
 *
 * 两个模型共用你的 ARK API Key（X-Api-Key），端点在 openspeech.bytedance.com：
 * - TTS:  wss://openspeech.bytedance.com/api/v3/plan/tts/unidirectional/stream
 *         一次性发全部文本，流式收音频分片（X-Api-Resource-Id: seed-tts-2.0）
 * - ASR:  wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async
 *         边推音频边出结果（X-Api-Resource-Id: volc.seedasr.sauc.duration）
 */
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";
import {
  Compression,
  EventType,
  MsgFlag,
  MsgType,
  Serialization,
  decodeFrame,
  decodeJsonPayload,
  encodeAudioChunk,
  encodeFrame,
  encodeFullRequest,
  type DecodedFrame,
} from "./frame.js";
import type { ASRProvider, ASRSegment, RecognizerOptions, StreamingRecognizer, SynthesisOptions, TTSProvider } from "./types.js";

const DEFAULT_TTS_BASE = "wss://openspeech.bytedance.com";
const DEFAULT_TTS_SPEAKER = "zh_female_gaolengyujie_uranus_bigtts";

/** 从 WS 消息流建一个带缓冲的异步迭代器（背压交给队列） */
function frameStream(ws: WebSocket, signal?: AbortSignal): AsyncIterable<DecodedFrame> {
  const queue: DecodedFrame[] = [];
  let waiters: Array<(r: IteratorResult<DecodedFrame>) => void> = [];
  let closed: Error | null = null;

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      queue.push(decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
      const waiter = waiters.shift();
      if (waiter) waiter({ value: queue.shift() as DecodedFrame, done: false });
    } catch (err) {
      closed = err instanceof Error ? err : new Error(String(err));
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    }
  });
  ws.on("close", () => {
    for (const w of waiters.splice(0)) w({ value: undefined, done: true });
  });
  ws.on("error", (err: Error) => {
    closed = err;
    for (const w of waiters.splice(0)) w({ value: undefined, done: true });
  });
  if (signal) {
    signal.addEventListener("abort", () => ws.close(), { once: true });
  }

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as DecodedFrame;
          continue;
        }
        if (closed) throw closed;
        const result = await new Promise<IteratorResult<DecodedFrame>>((resolve) => {
          waiters.push(resolve);
        });
        if (result.done) return;
        yield result.value;
      }
    },
  };
}

function waitForOpen(ws: WebSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const onAbort = (): void => {
      ws.close();
      const err = new Error("TTS 合成被中止");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    ws.once("error", (err: Error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

export interface ArkPlanTTSConfig {
  apiKey: string;
  /** Resource-Id，个人版固定 seed-tts-2.0 */
  resourceId?: string;
  speaker?: string;
  baseUrl?: string;
}

export class ArkPlanTTSProvider implements TTSProvider {
  readonly id = "ark-plan-tts";
  readonly model: string;

  constructor(private readonly config: ArkPlanTTSConfig) {
    this.model = config.resourceId ?? "seed-tts-2.0";
  }

  async *synthesize(text: string, options?: SynthesisOptions): AsyncIterable<Buffer> {
    const ws = new WebSocket(`${this.config.baseUrl ?? DEFAULT_TTS_BASE}/api/v3/plan/tts/unidirectional/stream`, {
      headers: {
        "X-Api-Key": this.config.apiKey,
        "X-Api-Resource-Id": this.model,
        "X-Control-Require-Usage-Tokens-Return": "*",
        "X-Api-Connect-Id": randomUUID(),
      },
    });
    await waitForOpen(ws, options?.signal);
    const frames = frameStream(ws, options?.signal);

    ws.send(encodeFullRequest({
      req_params: {
        text,
        speaker: options?.speaker ?? this.config.speaker ?? DEFAULT_TTS_SPEAKER,
        audio_params: {
          format: options?.format ?? "pcm",
          sample_rate: options?.sampleRate ?? 16_000,
        },
      },
    }));

    for await (const frame of frames) {
      if (frame.msgType === MsgType.ErrorResponse) {
        ws.close();
        throw new Error(`TTS 失败(code=${frame.errorCode}): ${frame.payload.toString("utf8")}`);
      }
      if (frame.msgType === MsgType.AudioOnlyServer && frame.payload.length > 0) {
        yield frame.compression === Compression.Gzip ? gunzipSync(frame.payload) : frame.payload;
      }
      if (frame.msgType === MsgType.FullServerResponse) {
        const event = frame.event ?? 0;
        if (event === EventType.SessionFinished) break;
        if (event === EventType.ConnectionFailed || event === EventType.SessionFailed) {
          ws.close();
          throw new Error(`TTS 会话失败: ${frame.payload.toString("utf8")}`);
        }
      }
    }
    ws.close();
  }
}

export interface ArkPlanASRConfig {
  apiKey: string;
  /** Resource-Id，流式识别固定 volc.seedasr.sauc.duration */
  resourceId?: string;
  baseUrl?: string;
  uid?: string;
  /** 识别语言提示，如 en-US / zh-CN；seed-asr 本身中英混识，提示可显著提升英文准确率 */
  language?: string;
}

export class ArkPlanASRProvider implements ASRProvider {
  readonly id = "ark-plan-asr";
  readonly model: string;

  constructor(private readonly config: ArkPlanASRConfig) {
    this.model = config.resourceId ?? "volc.seedasr.sauc.duration";
  }

  createRecognizer(options?: RecognizerOptions): StreamingRecognizer {
    const sampleRate = options?.sampleRate ?? 16_000;
    const connectId = randomUUID();
    const ws = new WebSocket(`${this.config.baseUrl ?? DEFAULT_TTS_BASE}/api/v3/plan/sauc/bigmodel_async`, {
      headers: {
        "X-Api-Key": this.config.apiKey,
        "X-Api-Resource-Id": this.model,
        "X-Api-Request-Id": connectId,
        "X-Api-Connect-Id": connectId,
        "X-Api-Sequence": "-1",
      },
    });

    // 序号 1 留给配置请求（POS_SEQUENCE），音频从 2 开始
    let sequence = 1;
    /** 引擎按内容嗅探音频格式：声明 wav + raw，需给裸 PCM 前置 RIFF 头 */
    const wavHeader = (() => {
      const header = Buffer.alloc(44);
      header.write("RIFF", 0, "ascii");
      header.writeUInt32LE(0xffff_fff0, 4); // 流式长度未知，放大占位
      header.write("WAVE", 8, "ascii");
      header.write("fmt ", 12, "ascii");
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); // PCM
      header.writeUInt16LE(1, 22); // mono
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(sampleRate * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36, "ascii");
      header.writeUInt32LE(0xffff_fff0, 40);
      return header;
    })();
    let headerSent = false;
    let finished = false;
    let opened = false;
    let lastAudioSent = false;
    /** 握手完成前的音频分片与结尾标记，open 后按序补发 */
    const backlog: Array<{ chunk: Buffer | null }> = [];
    let waiters: Array<(r: IteratorResult<ASRSegment>) => void> = [];
    let failure: Error | null = null;
    let latestText = "";

    const emit = (segment: ASRSegment): void => {
      const waiter = waiters.shift();
      waiter?.({ value: segment, done: false });
    };
    const fail = (err: Error): void => {
      failure = err;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    };
    const flush = (): void => {
      while (backlog.length > 0 && ws.readyState === WebSocket.OPEN) {
        const item = backlog.shift();
        sequence += 1;
        if (item && item.chunk !== null) {
          let payload = item.chunk;
          if (!headerSent) {
            headerSent = true;
            payload = Buffer.concat([wavHeader, payload]);
          }
          ws.send(encodeAudioChunk(payload, sequence));
        } else {
          lastAudioSent = true;
          ws.send(encodeAudioChunk(Buffer.alloc(0), -sequence)); // 负序号 = 最后一包
        }
      }
    };

    const finalize = (): void => {
      if (!finished) {
        finished = true;
        // 响应为累积快照：只在流结束时把最新全文定为终稿
        if (latestText.length > 0) emit({ text: latestText, definite: true });
        for (const w of waiters.splice(0)) w({ value: undefined, done: true });
      }
    };

    const handleFrame = (frame: DecodedFrame): void => {
      if (frame.msgType === MsgType.ErrorResponse) {
        fail(new Error(`ASR 失败(code=${frame.errorCode}): ${frame.payload.toString("utf8")}`));
        return;
      }
      if (frame.msgType !== MsgType.FullServerResponse) return;
      const event = frame.event ?? 0;
      if (event === EventType.ConnectionFailed || event === EventType.SessionFailed || event === EventType.ASREnded) {
        finalize();
        return;
      }
      if (frame.payload.length === 0) return;
      const body = decodeJsonPayload(frame) as {
        result?: { text?: string; utterances?: Array<{ text?: string; definite?: boolean }> };
      };
      const text = body.result?.text ?? "";
      if (text.length > 0 && text !== latestText) {
        latestText = text;
        emit({ text: latestText, definite: false }); // 中间快照，供 UI 实时上屏
      }
    };

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        handleFrame(decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on("error", (err: Error) => fail(err));
    ws.on("close", () => finalize());
    if (options?.signal) {
      options.signal.addEventListener("abort", () => ws.close(), { once: true });
    }

    ws.on("open", () => {
      opened = true;
      ws.send(encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgFlag.PositiveSeq,
        sequence: 1,
        serialization: Serialization.JSON,
        compression: Compression.Gzip,
        payload: gzipSync(Buffer.from(JSON.stringify({
          user: { uid: this.config.uid ?? "sema" },
          audio: { format: "wav", codec: "raw", rate: sampleRate, bits: 16, channel: 1 },
          request: {
            model_name: "bigmodel",
            enable_itn: true,
            enable_punc: true,
            enable_ddc: true,
            show_utterances: true,
            enable_nonstream: false,
            language: options?.language ?? this.config.language ?? "en-US",
            ...(options?.boostingTable && Object.keys(options.boostingTable).length > 0
              ? { corpus: { boosting_table: options.boostingTable } }
              : {}),
          },
        }), "utf8")),
      }));
      flush();
    });

    return {
      async push(chunk: Buffer): Promise<void> {
        if (failure) throw failure;
        backlog.push({ chunk });
        if (opened) flush();
      },
      async finish(): Promise<void> {
        if (failure) throw failure;
        if (!lastAudioSent) {
          backlog.push({ chunk: null });
          if (opened) flush();
        }
      },
      abort(): void {
        ws.close();
        finalize();
      },
      async *results(): AsyncIterable<ASRSegment> {
        while (true) {
          if (failure) throw failure;
          if (finished) return;
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
