import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { MockASRProvider, MockTTSProvider } from "@sema/ai-core";
import { RealtimeVoiceSession, type RealtimeCallbacks } from "./session.js";

/** 假 WS：只收集 send 调用，供单元级验证编排逻辑 */
function fakeWs(): { socket: WebSocket; sent: Array<string | Buffer> } {
  const sent: Array<string | Buffer> = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (data: string | Buffer) => sent.push(data),
  } as unknown as WebSocket;
  return { socket, sent };
}

function loud(ms: number): Buffer {
  const chunk = Buffer.alloc(ms * 32);
  for (let i = 0; i < chunk.length / 2; i += 1) {
    chunk.writeInt16LE(Math.round(Math.sin(i / 3) * 9000), i * 2);
  }
  return chunk;
}

function silence(ms: number): Buffer {
  return Buffer.alloc(ms * 32);
}

function makeSession(script: Array<string | [string, string]>, tts: MockTTSProvider): {
  session: RealtimeVoiceSession;
  events: Array<{ type: string; [k: string]: unknown }>;
  audio: Buffer[];
} {
  const { socket } = fakeWs();
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const audio: Buffer[] = [];
  const asr = new MockASRProvider(script);
  const conversations = {
    // 语音轮按说话秒数计费：mock 只回固定金额，秒数由实现侧计算
    turnVoice: async (_id: string, _text: string, seconds: number) => ({
      sessionId: "s1",
      reply: "Sure thing — anything else?",
      chargedCents: Math.max(1, Math.ceil(seconds)) * 5,
      balanceCredits: "30",
    }),
  } as unknown as ConstructorParameters<typeof RealtimeVoiceSession>[2];
  const callbacks: RealtimeCallbacks = {
    onUserUtterance: (text) => events.push({ type: "user-utterance", text }),
    onReplyStart: () => events.push({ type: "reply-start" }),
    onReply: (info) => events.push({ type: "reply", ...info }),
    onAudioChunk: (chunk) => audio.push(chunk),
    onReplyEnd: () => events.push({ type: "audio-end" }),
    onError: (message) => events.push({ type: "error", message }),
  };
  const session = new RealtimeVoiceSession(
    socket,
    "u1",
    conversations,
    asr,
    tts,
    callbacks,
    { rmsThreshold: 500, minSpeechFrames: 2, hangoverFrames: 3 },
  );
  return { session, events, audio };
}

const TICK = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("实时语音会话编排", () => {
  it("VAD 断句 → 转写 → 回复 → 音频，全流程", async () => {
    const { session, events, audio } = makeSession([["Hi Ben", "Hi Ben"]], new MockTTSProvider());
    session.pushAudio(silence(40));
    session.pushAudio(loud(120)); // 开口
    session.pushAudio(silence(100)); // 收尾（静音 100ms > hangover 60ms）
    await TICK(80);

    const types = events.map((e) => e.type);
    expect(types).toContain("user-utterance");
    const utterance = events.find((e) => e.type === "user-utterance");
    expect(utterance?.text).toBe("Hi Ben");
    expect(types).toContain("reply-start");
    const reply = events.find((e) => e.type === "reply");
    expect(reply?.reply).toContain("anything else");
    expect(audio.length).toBeGreaterThan(0);
    expect(types).toContain("audio-end");
  }, 10_000);

  it("纯噪声段（无转写文本）静默丢弃", async () => {
    // ASR 脚本已空 → 转写为空 → 不触发回复
    const { session, events, audio } = makeSession([], new MockTTSProvider());
    session.pushAudio(loud(150));
    session.pushAudio(silence(100));
    await TICK(60);
    expect(events.find((e) => e.type === "reply")).toBeUndefined();
    expect(audio).toHaveLength(0);
  }, 10_000);

  it("Barge-in：用户开口掐断 AI 播报，新语音段立即接管", async () => {
    // 每块 40ms 延迟 × 12 块 ≈ 480ms 播报窗口，留给用户插入
    const { session, events } = makeSession(
      [["first", "first"], ["second", "second"]],
      new MockTTSProvider(0.1, 12, 40),
    );
    // 第一轮
    session.pushAudio(loud(120));
    session.pushAudio(silence(100));
    await TICK(30); // turn 已完成、TTS 播报中
    // 用户开口 → 打断
    session.pushAudio(loud(150));
    session.pushAudio(silence(100));
    await TICK(600);

    const replies = events.filter((e) => e.type === "reply");
    expect(replies).toHaveLength(2); // 两轮都拿到了 LLM 回复
    const ends = events.map((e) => e.type).filter((t) => t === "audio-end");
    expect(ends.length).toBeGreaterThanOrEqual(2); // 首轮被掐断也发 audio-end，次轮正常结束
    const utterances = events.filter((e) => e.type === "user-utterance");
    expect(utterances.map((u) => u.text)).toEqual(["first", "second"]);
  }, 10_000);
});
