/**
 * 火山引擎语音 WebSocket 二进制帧协议编解码器
 *
 * 与官方 protocols.py（Agent/Coding Plan 语音模型接入文档附件）逐字段对齐：
 * 帧头 4 字节 [version|headerSize, msgType|flags, serialization|compression, 保留]，
 * 可选扩展字段按消息类型与标志位排列，最后是 4 字节长度前缀的 payload。
 *
 * 注意（与官方实现一致的两处不对称，不要"修正"）：
 * - 写方向 WithEvent 帧先写 event/sessionId，再写 sequence
 * - 读方向带 sequence 标志的帧先读 sequence，再读 event/sessionId/connectId
 */
import { gunzipSync, gzipSync } from "node:zlib";

export const MsgType = {
  FullClientRequest: 0b0001,
  AudioOnlyClient: 0b0010,
  FullServerResponse: 0b1001,
  AudioOnlyServer: 0b1011,
  FrontEndResultServer: 0b1100,
  ErrorResponse: 0b1111,
} as const;
export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

export const MsgFlag = {
  NoSeq: 0b0000,
  PositiveSeq: 0b0001,
  LastNoSeq: 0b0010,
  NegativeSeq: 0b0011,
  WithEvent: 0b0100,
} as const;
export type MsgFlagValue = (typeof MsgFlag)[keyof typeof MsgFlag];

export const Serialization = { Raw: 0b0000, JSON: 0b0001 } as const;

export const Compression = { None: 0b0000, Gzip: 0b0001 } as const;

export const EventType = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,
  TaskRequest: 200,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSEnded: 359,
  ASRInfo: 450,
  ASRResponse: 451,
  ASREnded: 459,
} as const;
export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

/** 连接级事件（帧中不携带 sessionId；其中三个下游事件还带 connectId） */
const CONNECTION_EVENTS = new Set<number>([
  EventType.StartConnection,
  EventType.FinishConnection,
  EventType.ConnectionStarted,
  EventType.ConnectionFailed,
  EventType.ConnectionFinished,
]);
/** 写方向跳过 sessionId 的事件（官方列表不含 ConnectionFinished） */
const WRITE_SKIP_SESSION = new Set<number>([
  EventType.StartConnection,
  EventType.FinishConnection,
  EventType.ConnectionStarted,
  EventType.ConnectionFailed,
]);
/** 读方向携带 connectId 的下游事件 */
const READ_CONNECT_EVENTS = new Set<number>([
  EventType.ConnectionStarted,
  EventType.ConnectionFailed,
  EventType.ConnectionFinished,
]);

const SEQUENCE_TYPES = new Set<number>([
  MsgType.FullClientRequest,
  MsgType.FullServerResponse,
  MsgType.FrontEndResultServer,
  MsgType.AudioOnlyClient,
  MsgType.AudioOnlyServer,
]);

export interface FrameOptions {
  type: MsgTypeValue;
  flag: MsgFlagValue;
  serialization?: number;
  compression?: number;
  event?: number;
  sessionId?: string;
  sequence?: number;
  errorCode?: number;
  payload?: Buffer;
}

/** 编码一帧客户端消息（写方向：event/sessionId 先于 sequence，见模块注释） */
export function encodeFrame(options: FrameOptions): Buffer {
  const serialization = options.serialization ?? Serialization.JSON;
  const compression = options.compression ?? Compression.None;
  const header = Buffer.from([
    0x11,
    (options.type << 4) | options.flag,
    (serialization << 4) | compression,
    0x00,
  ]);
  const parts: Buffer[] = [header];

  if (options.flag === MsgFlag.WithEvent) {
    const event = Buffer.alloc(4);
    event.writeInt32BE(options.event ?? 0);
    parts.push(event);
    if (options.event === undefined || !WRITE_SKIP_SESSION.has(options.event)) {
      const sessionId = Buffer.from(options.sessionId ?? "", "utf8");
      const size = Buffer.alloc(4);
      size.writeUInt32BE(sessionId.length);
      parts.push(size, sessionId);
    }
  }
  if (SEQUENCE_TYPES.has(options.type) && (options.flag === MsgFlag.PositiveSeq || options.flag === MsgFlag.NegativeSeq)) {
    const seq = Buffer.alloc(4);
    seq.writeInt32BE(options.sequence ?? 0);
    parts.push(seq);
  }
  if (options.type === MsgType.ErrorResponse) {
    const code = Buffer.alloc(4);
    code.writeUInt32BE(options.errorCode ?? 0);
    parts.push(code);
  }
  const payload = options.payload ?? Buffer.alloc(0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  parts.push(size, payload);
  return Buffer.concat(parts);
}

export interface DecodedFrame {
  msgType: MsgTypeValue;
  flag: MsgFlagValue;
  serialization: number;
  compression: number;
  event?: number;
  sessionId?: string;
  connectId?: string;
  sequence?: number;
  errorCode?: number;
  payload: Buffer;
}

/** 解码一帧服务端消息（读方向：sequence 先于 event/sessionId/connectId） */
export function decodeFrame(data: Buffer): DecodedFrame {
  if (data.length < 4) throw new Error(`帧过短: ${data.length} 字节`);
  const headerSize = (data[0] as number) & 0x0f;
  const headerBytes = headerSize * 4;
  if (data.length < headerBytes) throw new Error(`帧头不完整: 声明 ${headerBytes} 字节, 实得 ${data.length}`);
  const msgType = ((data[1] as number) >> 4) as MsgTypeValue;
  const flag = ((data[1] as number) & 0x0f) as MsgFlagValue;
  const serialization = (data[2] as number) >> 4;
  const compression = (data[2] as number) & 0x0f;

  let offset = headerBytes;
  const frame: DecodedFrame = { msgType, flag, serialization, compression, payload: Buffer.alloc(0) };

  if (SEQUENCE_TYPES.has(msgType) && (flag === MsgFlag.PositiveSeq || flag === MsgFlag.NegativeSeq)) {
    frame.sequence = data.readInt32BE(offset);
    offset += 4;
  } else if (msgType === MsgType.ErrorResponse) {
    frame.errorCode = data.readUInt32BE(offset);
    offset += 4;
  }
  if (flag === MsgFlag.WithEvent) {
    frame.event = data.readInt32BE(offset);
    offset += 4;
    const skipSession =
      frame.event !== undefined && CONNECTION_EVENTS.has(frame.event);
    if (!skipSession) {
      const sessionIdSize = data.readUInt32BE(offset);
      offset += 4;
      if (sessionIdSize > 0) {
        frame.sessionId = data.subarray(offset, offset + sessionIdSize).toString("utf8");
        offset += sessionIdSize;
      }
    }
    if (frame.event !== undefined && READ_CONNECT_EVENTS.has(frame.event)) {
      const connectSize = data.readUInt32BE(offset);
      offset += 4;
      if (connectSize > 0) {
        frame.connectId = data.subarray(offset, offset + connectSize).toString("utf8");
        offset += connectSize;
      }
    }
  }
  if (offset + 4 > data.length) throw new Error("帧缺少 payload 长度字段");
  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  frame.payload = data.subarray(offset, offset + payloadSize);
  return frame;
}

/** 全量客户端请求帧（TTS 单流接口的握手帧：JSON、不压缩） */
export function encodeFullRequest(json: unknown): Buffer {
  return encodeFrame({
    type: MsgType.FullClientRequest,
    flag: MsgFlag.NoSeq,
    serialization: Serialization.JSON,
    compression: Compression.None,
    payload: Buffer.from(JSON.stringify(json), "utf8"),
  });
}

/** 音频帧：gzip 压缩的原始 PCM；seq>0 普通，seq<0 结尾 */
export function encodeAudioChunk(chunk: Buffer, sequence: number): Buffer {
  return encodeFrame({
    type: MsgType.AudioOnlyClient,
    flag: sequence > 0 ? MsgFlag.PositiveSeq : MsgFlag.NegativeSeq,
    serialization: Serialization.Raw,
    compression: Compression.Gzip,
    sequence,
    payload: gzipSync(chunk),
  });
}

/** 解压并解析服务端 JSON 全量响应帧（ASR 识别结果等） */
export function decodeJsonPayload(frame: DecodedFrame): unknown {
  const raw =
    frame.compression === Compression.Gzip
      ? gunzipSync(frame.payload)
      : frame.payload;
  return JSON.parse(raw.toString("utf8")) as unknown;
}
