/**
 * 实时语音客户端（WS /v1/realtime）
 *
 * 协议（与后端 architecture.md §7.3 对齐）：
 * - 上行 JSON：start{token,scenarioId} / audio-aac{data:base64} / end
 *   （Expo Go 的 Android 录音只有 AAC，整段上传由服务端 ffmpeg 转 PCM）
 * - 上行二进制：PCM 16k mono s16le 分片（预留真流式，Expo Go 不可用）
 * - 下行二进制：AI TTS PCM 分片
 * - 下行 JSON：ready / user-utterance / reply-start / reply / audio-end / ended / error
 */
import { API_BASE } from "./api";

export interface VoiceHandlers {
  onReady: (info: { sessionId: string; opener: string; centsPerSecond: number }) => void;
  onUserUtterance: (text: string) => void;
  onReplyStart: () => void;
  onReply: (info: { reply: string; chargedCents: number; balanceCredits: string; translation?: string; suggestion?: string }) => void;
  /** TTS PCM 分片（16k mono s16le），播放端负责攒齐 */
  onAudioChunk: (chunk: ArrayBuffer) => void;
  onAudioEnd: () => void;
  onError: (message: string, code?: string) => void;
  onEnded: () => void;
}

export class VoiceClient {
  private ws: WebSocket | null = null;
  private ready = false;
  /** 主动关闭标记：close()/stop() 触发的 onclose/onerror 不当错误处理 */
  private intentionalClose = false;
  private handlers: VoiceHandlers;

  constructor(handlers: VoiceHandlers) {
    this.handlers = handlers;
  }

  /** 服务端已确认 start（收过 ready 帧） */
  isReady(): boolean {
    return this.ready;
  }

  connect(token: string, scenarioId: string, sessionId?: string): void {
    const wsUrl = `${API_BASE.replace(/^http/, "ws")}/v1/realtime`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onmessage = (event: WebSocketMessageEvent) => {
      if (typeof event.data === "string") {
        this.handleJson(JSON.parse(event.data) as Record<string, unknown>);
      } else {
        this.handlers.onAudioChunk(event.data as ArrayBuffer);
      }
    };
    ws.onerror = () => {
      if (this.intentionalClose) return; // 主动关闭引发的 error 不提示
      this.handlers.onError("语音连接出错，请检查网络与后端服务");
    };
    ws.onclose = (ev: WebSocketCloseEvent) => {
      const code = (ev as { code?: number }).code;
      if (this.intentionalClose || code === 1000) {
        console.log(`[voice] WS 正常关闭(code=${code})`); // 主动结束/正常关闭不是错误
      } else {
        console.error(`[voice] WS 异常断开: code=${code} reason=${(ev as { reason?: string }).reason ?? "-"}`);
        this.handlers.onError("语音连接已断开，请关掉语音重开一次");
      }
      this.ws = null;
      this.ready = false;
    };

    // RN 的 WebSocket 在 CONNECTING 状态 send 会同步抛 INVALID_STATE_ERR，
    // start 帧必须等握手完成（onopen）后再发
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "start",
        token,
        scenarioId,
        ...(sessionId ? { sessionId } : {}),
      }));
    };
  }

  private handleJson(j: Record<string, unknown>): void {
    switch (j.type) {
      case "ready":
        this.ready = true;
        this.handlers.onReady({
          sessionId: String(j.sessionId),
          opener: String(j.opener),
          centsPerSecond: Number((j.pricing as { centsPerSecond?: number } | undefined)?.centsPerSecond ?? 5),
        });
        break;
      case "user-utterance":
        this.handlers.onUserUtterance(String(j.text));
        break;
      case "reply-start":
        this.handlers.onReplyStart();
        break;
      case "reply":
        this.handlers.onReply({
          reply: String(j.reply),
          chargedCents: Number(j.chargedCents),
          balanceCredits: String(j.balanceCredits),
          ...(typeof j.translation === "string" && j.translation ? { translation: j.translation } : {}),
          ...(typeof j.suggestion === "string" && j.suggestion ? { suggestion: j.suggestion } : {}),
        });
        break;
      case "audio-end":
        this.handlers.onAudioEnd();
        break;
      case "error":
        this.handlers.onError(String(j.message), j.code ? String(j.code) : undefined);
        break;
      case "ended":
        this.handlers.onEnded();
        break;
      default:
        break;
    }
  }

  /** 按住说话：松手后把整段 AAC（base64）发出去 */
  sendAacBase64(base64: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`[voice] 音频未发送：WS readyState=${ws?.readyState ?? "null"}`);
      this.handlers.onError("语音连接已断开，请关掉语音重开一次");
      return;
    }
    console.log(`[voice] 发送 audio-aac：${Math.round(base64.length / 1024)}KB（readyState=OPEN）`);
    ws.send(JSON.stringify({ type: "audio-aac", data: base64 }));
  }

  end(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "end" }));
    }
  }

  close(): void {
    this.intentionalClose = true;
    try {
      this.ws?.close();
    } catch {
      // 连接已断
    }
    this.ws = null;
    this.ready = false;
  }
}
