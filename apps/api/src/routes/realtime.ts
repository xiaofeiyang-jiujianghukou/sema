/**
 * WS /v1/realtime —— 实时语音双通道路由
 *
 * 协议（architecture.md §7.3）：
 * - 上行二进制帧 = 用户 PCM（16k mono s16le，任意分片）
 * - 上行 JSON 控制帧：start{userId,scenarioId} / end / interrupt
 * - 下行二进制帧 = AI PCM（16k mono s16le，可直接喂播放器）
 * - 下行 JSON 事件帧：ready / user-utterance / reply / audio-end / ended / error
 */
import type { FastifyPluginAsync } from "fastify";
import type WebSocket from "ws";
import { z } from "zod";
import { RealtimeVoiceSession } from "../modules/realtime/session.js";
import { aacToPcm } from "../modules/realtime/transcode.js";
import { getScenario } from "../content/scenarios.js";

/**
 * 情景词表 → SAUC 热词表：targetVocab 条目按 "/"、"、" 拆分成可说的短语，
 * 过滤掉含省略号/中文的模板条目（如 "I'd like ..."）
 */
function buildBoostingTable(scenarioId: string, vocab: string[]): Record<string, number> {
  const table: Record<string, number> = {};
  const extra: Record<string, string[]> = {
    "coffee-order": ["whole milk", "oat milk", "semi-skimmed milk", "latte", "cappuccino", "americano", "espresso", "croissant", "to go", "for here", "medium"],
  };
  for (const entry of [...vocab, ...(extra[scenarioId] ?? [])]) {
    for (const piece of entry.split(/[/、]/)) {
      const term = piece.trim().replace(/[.?!…]+$/, "").toLowerCase();
      if (term.length >= 3 && /^[a-z\u00C0-\u024F][a-z\u00C0-\u024F' -]+$/.test(term) && !term.includes("...")) {
        table[term] = 20;
      }
    }
  }
  return table;
}

const startSchema = z.object({
  type: z.literal("start"),
  token: z.string().min(16).max(128),
  scenarioId: z.string().min(1).max(64),
  /** 可选：复用已有会话（移动端文字/语音共用一个会话）；缺省开新会话 */
  sessionId: z.string().uuid().optional(),
});
const endSchema = z.object({ type: z.literal("end") });
/** 移动端按住说话：整段 AAC（base64）→ 服务端转 PCM → VAD 管线 */
const audioAacSchema = z.object({
  type: z.literal("audio-aac"),
  data: z.string().min(8).max(4_000_000),
});

export const realtimeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/realtime", { websocket: true }, (socket: WebSocket) => {
    let session: RealtimeVoiceSession | null = null;
    let sessionId: string | null = null;

    const send = (payload: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };

    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        session?.pushAudio(data as Buffer);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse((data as Buffer).toString("utf8"));
        console.log(`[realtime] 收到控制帧: ${(parsed as { type?: string }).type ?? "?"} (${Math.round((data as Buffer).length / 1024)}KB)`);
      } catch {
        send({ type: "error", message: "控制帧必须是 JSON" });
        return;
      }

      const endCheck = endSchema.safeParse(parsed);
      if (endCheck.success) {
        void (async () => {
          session?.close();
          if (sessionId) {
            try {
              const summary = await app.conversations.end(sessionId);
              send({ type: "ended", ...summary });
            } catch {
              send({ type: "ended", sessionId });
            }
          } else {
            send({ type: "ended" });
          }
          socket.close();
        })();
        return;
      }

      const aacCheck = audioAacSchema.safeParse(parsed);
      if (aacCheck.success) {
        if (!session) {
          send({ type: "error", message: "会话尚未开始，请先发送 start" });
          return;
        }
        void (async () => {
          try {
            console.log(`[realtime] audio-aac 收到 ${Math.round(aacCheck.data.data.length / 1024)}KB base64，开始转码`);
            const pcm = await aacToPcm(Buffer.from(aacCheck.data.data, "base64"));
            console.log(`[realtime] 转码完成 ${(pcm.length / 2 / 16000).toFixed(2)}s PCM，送 VAD`);
            // 按住说话：一次按压 = 一个发言（整段送识别，不被静音判定切碎）
            session?.pushUtterance(pcm);
          } catch (err) {
            send({ type: "error", message: `音频转码失败: ${err instanceof Error ? err.message : String(err)}` });
          }
        })();
        return;
      }

      const startCheck = startSchema.safeParse(parsed);
      if (!startCheck.success) {
        send({ type: "error", message: "控制帧格式错误", detail: startCheck.error.issues });
        return;
      }

      void (async () => {
        const { token, scenarioId, sessionId: reuseId } = startCheck.data;
        try {
          const userId = app.auth.userIdOf(token); // 无效令牌 → 抛 TOKEN_INVALID
          const started = reuseId
            ? await app.conversations.resumeVoice(userId, reuseId)
            : await app.conversations.start(userId, scenarioId);
          const resumeSession = Boolean(reuseId);
          sessionId = started.sessionId;
          session = new RealtimeVoiceSession(
            socket,
            started.sessionId,
            app.conversations,
            app.speech.asr,
            app.speech.tts,
            {
              onUserUtterance: (text) => {
                console.log(`[realtime] ASR 出段: "${text}"`);
                send({ type: "user-utterance", text });
              },
              onReplyStart: () => {
                console.log("[realtime] LLM 回复生成中");
                send({ type: "reply-start" });
              },
              onReply: (info) => {
                console.log(`[realtime] 回复: "${info.reply.slice(0, 40)}" 计费${info.chargedCents}厘`);
                send({ type: "reply", ...info });
              },
              onAudioChunk: (chunk) => {
                if (socket.readyState === socket.OPEN) socket.send(chunk);
              },
              onReplyEnd: () => send({ type: "audio-end" }),
              onError: (message) => send({ type: "error", message }),
            },
            app.vadOptions,
            {
              ...app.speechForLang(started.scenario.targetLang),
              // 情景领域词汇 → ASR 热词 boosting（如 "whole milk / oat milk" 拆词），
              // 解决口音 + 领域词导致的误识别（"whole milk" → "Horrormark"）
              boostingTable: buildBoostingTable(
                started.scenario.id,
                getScenario(started.scenario.id)?.targetVocab ?? [],
              ),
            },
          );
          send({
            type: "ready",
            sessionId: started.sessionId,
            opener: started.opener,
            pricing: started.pricing,
            scenario: started.scenario,
          });
          // 开场白语音：仅新会话播（复用会话不重放）；失败不阻断会话
          if (!resumeSession) {
            try {
              for await (const chunk of app.speech.tts.synthesize(started.opener, { format: "pcm", sampleRate: 16_000 })) {
                if (socket.readyState === socket.OPEN) socket.send(chunk);
              }
            } catch (err) {
              send({ type: "error", message: `开场白语音失败: ${err instanceof Error ? err.message : String(err)}` });
            }
          }
          send({ type: "audio-end" });
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "SCENARIO_NOT_FOUND" || code === "TOKEN_INVALID" || code === "CONVERSATION_NOT_FOUND" || code === "CONVERSATION_FORBIDDEN" || code === "CONVERSATION_ENDED") {
            send({ type: "error", code, message: (err as Error).message });
          } else {
            send({ type: "error", message: err instanceof Error ? err.message : String(err) });
          }
        }
      })();
    });

    socket.on("close", () => session?.close());
  });
};
