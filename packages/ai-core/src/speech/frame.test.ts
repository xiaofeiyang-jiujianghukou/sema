import { describe, expect, it } from "vitest";
import { Compression, MsgFlag, MsgType, Serialization, decodeFrame, decodeJsonPayload, encodeAudioChunk, encodeFrame, encodeFullRequest } from "./frame.js";
import { gunzipSync, gzipSync } from "node:zlib";

describe("语音帧协议编解码器", () => {
  it("往返：无事件全量请求", () => {
    const payload = Buffer.from(JSON.stringify({ req_params: { text: "hi" } }));
    const encoded = encodeFrame({
      type: MsgType.FullClientRequest,
      flag: MsgFlag.NoSeq,
      serialization: Serialization.JSON,
      compression: Compression.None,
      payload,
    });
    expect(encoded[0]).toBe(0x11);
    expect(encoded[1]).toBe((MsgType.FullClientRequest << 4) | MsgFlag.NoSeq);

    const decoded = decodeFrame(encoded);
    expect(decoded.msgType).toBe(MsgType.FullClientRequest);
    expect(decoded.flag).toBe(MsgFlag.NoSeq);
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it("往返：带事件的会话帧（event + sessionId）", () => {
    const encoded = encodeFrame({
      type: MsgType.FullClientRequest,
      flag: MsgFlag.WithEvent,
      event: 100, // StartSession
      sessionId: "sess-1",
      payload: Buffer.from("{}"),
    });
    const decoded = decodeFrame(encoded);
    expect(decoded.event).toBe(100);
    expect(decoded.sessionId).toBe("sess-1");
  });

  it("往返：连接级事件不带 sessionId", () => {
    const encoded = encodeFrame({
      type: MsgType.FullClientRequest,
      flag: MsgFlag.WithEvent,
      event: 1, // StartConnection
      sessionId: "should-be-skipped",
      payload: Buffer.from("{}"),
    });
    const decoded = decodeFrame(encoded);
    expect(decoded.event).toBe(1);
    expect(decoded.sessionId).toBeUndefined();
  });

  it("音频帧：正序号/负序号（结尾）+ gzip", () => {
    const audio = Buffer.alloc(640, 7);
    const normal = decodeFrame(encodeAudioChunk(audio, 1));
    expect(normal.flag).toBe(MsgFlag.PositiveSeq);
    expect(normal.sequence).toBe(1);
    expect(normal.compression).toBe(Compression.Gzip);
    expect(gunzipSync(normal.payload).equals(audio)).toBe(true);

    const last = decodeFrame(encodeAudioChunk(audio, -2));
    expect(last.flag).toBe(MsgFlag.NegativeSeq);
    expect(last.sequence).toBe(-2);
  });

  it("错误帧：带错误码与文本 payload", () => {
    const encoded = encodeFrame({
      type: MsgType.ErrorResponse,
      flag: MsgFlag.NoSeq,
      errorCode: 45000001,
      payload: Buffer.from("bad key"),
    });
    const decoded = decodeFrame(encoded);
    expect(decoded.msgType).toBe(MsgType.ErrorResponse);
    expect(decoded.errorCode).toBe(45000001);
    expect(decoded.payload.toString()).toBe("bad key");
  });

  it("gzip JSON 响应解码", () => {
    const encoded = encodeFrame({
      type: MsgType.FullServerResponse,
      flag: MsgFlag.NoSeq,
      serialization: Serialization.JSON,
      compression: Compression.Gzip,
      payload: gzipSync(Buffer.from(JSON.stringify({ result: { text: "你好" } }))),
    });
    const decoded = decodeFrame(encoded);
    expect(decodeJsonPayload(decoded)).toEqual({ result: { text: "你好" } });
  });

  it("encodeFullRequest 产出 TTS 握手帧", () => {
    const frame = decodeFrame(encodeFullRequest({ req_params: { text: "hello" } }));
    expect(frame.msgType).toBe(MsgType.FullClientRequest);
    expect(frame.serialization).toBe(Serialization.JSON);
    expect(frame.compression).toBe(Compression.None);
  });

  it("过短帧抛错", () => {
    expect(() => decodeFrame(Buffer.from([0x11]))).toThrow(/帧过短/);
  });
});
