/** ASR 裸协议调试：看服务端每一帧 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Compression, MsgFlag, MsgType, Serialization, decodeFrame, decodeJsonPayload, encodeAudioChunk, encodeFrame } from "@sema/ai-core";
import { gzipSync } from "node:zlib";

function envKey(): string {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split(/\r?\n/)) {
    if (line.startsWith("SEMA_LLM_API_KEY=")) return line.slice(17).trim();
  }
  throw new Error("no key");
}

async function main(): Promise<void> {
  const apiKey = envKey();
  const audio = readFileSync(new URL("./.roundtrip.pcm", import.meta.url));
  console.log("音频:", audio.length, "字节");
  const ws = new WebSocket(process.env.ASR_URL ?? "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async", {
    headers: { "X-Api-Key": apiKey, "X-Api-Resource-Id": "volc.seedasr.sauc.duration", "X-Api-Connect-Id": randomUUID() },
  });
  ws.on("open", async () => {
    console.log("✓ WS 已连上");
    ws.send(encodeFrame({
      type: MsgType.FullClientRequest, flag: MsgFlag.NoSeq,
      serialization: Serialization.JSON, compression: Compression.Gzip,
      payload: gzipSync(Buffer.from(JSON.stringify({
        user: { uid: "sema" },
        audio: { format: "wav", codec: "raw", rate: 16000, bits: 16, channel: 1 },
        request: { model_name: "bigmodel", enable_punc: true, show_utterances: true },
      }))),
    }));
    let seq = 1; // 配置请求占掉序号 1，音频从 2 开始
    const slice = 3200;
    const paced = process.env.ASR_PACED === "1";
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    // WAV 头（引擎按内容嗅探格式）
    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0, "ascii");
    wavHeader.writeUInt32LE(0xfffffff0, 4);
    wavHeader.write("WAVE", 8, "ascii");
    wavHeader.write("fmt ", 12, "ascii");
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(1, 22);
    wavHeader.writeUInt32LE(16000, 24);
    wavHeader.writeUInt32LE(32000, 28);
    wavHeader.writeUInt16LE(2, 32);
    wavHeader.writeUInt16LE(16, 34);
    wavHeader.write("data", 36, "ascii");
    wavHeader.writeUInt32LE(0xfffffff0, 40);
    ws.send(encodeAudioChunk(Buffer.concat([wavHeader, audio.subarray(0, slice)]), (seq += 1)));
    let offset = slice;
    while (offset < audio.length) {
      const chunk = audio.subarray(offset, Math.min(offset + slice, audio.length));
      seq += 1;
      ws.send(encodeAudioChunk(chunk, seq));
      offset += slice;
      if (paced) await sleep(100);
    }
    seq += 1;
    ws.send(encodeAudioChunk(Buffer.alloc(0), -seq));
    console.log("✓ 音频发送完毕，等待结果…");
    console.log("✓ 已发送", seq, "包");
  });
  ws.on("message", (data: WebSocket.RawData) => {
    const frame = decodeFrame(data as Buffer);
    const body = frame.msgType === MsgType.FullServerResponse && frame.payload.length > 0
      ? JSON.stringify(decodeJsonPayload(frame)).slice(0, 400) : frame.payload.toString("utf8").slice(0, 200);
    console.log(`← type=${frame.msgType} flag=${frame.flag} event=${frame.event} seq=${frame.sequence} size=${frame.payload.length} | ${body}`);
  });
  ws.on("close", (code, reason) => { console.log("✗ 关闭:", code, reason.toString()); process.exit(0); });
  ws.on("error", (e: Error) => { console.log("✗ 错误:", e.message); process.exit(1); });
  setTimeout(() => { console.log("超时退出"); process.exit(0); }, 20000);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
