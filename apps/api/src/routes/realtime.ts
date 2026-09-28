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

const startSchema = z.object({
  type: z.literal("start"),
  userId: z.string().min(1).max(64),
  scenarioId: z.string().min(1).max(64),
});
const endSchema = z.object({ type: z.literal("end") });

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

      const startCheck = startSchema.safeParse(parsed);
      if (!startCheck.success) {
        send({ type: "error", message: "控制帧格式错误", detail: startCheck.error.issues });
        return;
      }

      void (async () => {
        const { userId, scenarioId } = startCheck.data;
        try {
          const started = await app.conversations.start(userId, scenarioId);
          sessionId = started.sessionId;
          session = new RealtimeVoiceSession(
            socket,
            started.sessionId,
            app.conversations,
            app.speech.asr,
            app.speech.tts,
            {
              onUserUtterance: (text) => send({ type: "user-utterance", text }),
              onReplyStart: () => send({ type: "reply-start" }),
              onReply: (info) => send({ type: "reply", ...info }),
              onAudioChunk: (chunk) => {
                if (socket.readyState === socket.OPEN) socket.send(chunk);
              },
              onReplyEnd: () => send({ type: "audio-end" }),
              onError: (message) => send({ type: "error", message }),
            },
            app.vadOptions,
            app.speechForLang(started.scenario.targetLang),
          );
          send({
            type: "ready",
            sessionId: started.sessionId,
            opener: started.opener,
            pricing: started.pricing,
            scenario: started.scenario,
          });
          // 开场白也用声音说出来（预生成资产，仅 TTS 成本）；失败不阻断会话
          try {
            for await (const chunk of app.speech.tts.synthesize(started.opener, { format: "pcm", sampleRate: 16_000 })) {
              if (socket.readyState === socket.OPEN) socket.send(chunk);
            }
          } catch (err) {
            send({ type: "error", message: `开场白语音失败: ${err instanceof Error ? err.message : String(err)}` });
          }
          send({ type: "audio-end" });
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "SCENARIO_NOT_FOUND") {
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
