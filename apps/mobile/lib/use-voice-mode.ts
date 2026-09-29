/**
 * 语音对话模式：按住说话（AAC 整段上传）→ AI 文本回复 + TTS 播放
 *
 * Expo Go 约束（诚实边界）：
 * - Android 录音只有 AAC 容器（无 PCM），整段上传由服务端 ffmpeg 转 PCM
 * - 因此这是「按住说话」而非边说边转——真流式（barge-in 由服务端 VAD 保留）
 *   需要 dev-client + 原生录音模块，是后续里程碑
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { pcmToWav } from "./pcm";
import { VoiceClient } from "./voice";

export type VoiceState = "off" | "connecting" | "listening" | "thinking" | "speaking";

interface VoiceEvent {
  kind: "user" | "assistant";
  text: string;
  chargedCents?: number;
  balanceCredits?: string;
}

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: false,
  android: {
    extension: ".aac",
    outputFormat: Audio.AndroidOutputFormat.AAC_ADTS,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16_000,
    numberOfChannels: 1,
    bitRate: 48_000,
  },
  ios: {
    extension: ".m4a",
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 16_000,
    numberOfChannels: 1,
    bitRate: 48_000,
  },
  web: {},
};

export function useVoiceMode(opts: {
  token: string;
  scenarioId: string;
  /** 复用当前文字会话（语音与文字同会话，计费/复盘一致） */
  sessionId?: string;
  onEvent: (ev: VoiceEvent) => void;
  onError: (message: string) => void;
}): {
  state: VoiceState;
  start: () => void;
  stop: () => void;
  pushToTalkStart: () => Promise<void>;
  pushToTalkEnd: () => Promise<void>;
} {
  const { token, scenarioId, sessionId } = opts;
  const [state, setState] = useState<VoiceState>("off");
  const clientRef = useRef<VoiceClient | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const pcmRef = useRef<Uint8Array[]>([]);
  const soundRef = useRef<Audio.Sound | null>(null);
  const speakingRef = useRef(false);

  const stopPlayback = useCallback(async (): Promise<void> => {
    speakingRef.current = false;
    const sound = soundRef.current;
    if (sound) {
      try {
        await sound.stopAsync();
        await sound.unloadAsync();
      } catch {
        // 已卸载
      }
      soundRef.current = null;
    }
  }, []);

  const playPcm = useCallback(async (): Promise<void> => {
    const pcm = pcmRef.current;
    pcmRef.current = [];
    if (pcm.length === 0) return;
    const total = pcm.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of pcm) {
      merged.set(c, offset);
      offset += c.length;
    }
    const file = `${FileSystem.cacheDirectory}sema-tts-${Date.now()}.wav`;
    await FileSystem.writeAsStringAsync(file, bytesToBase64(pcmToWav(merged)), { encoding: FileSystem.EncodingType.Base64 });
    try {
      const { sound } = await Audio.Sound.createAsync({ uri: file }, { shouldPlay: true }, undefined, false);
      soundRef.current = sound;
      speakingRef.current = true;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded && status.error) {
          opts.onError(`播放失败: ${status.error}`);
        }
        if (status.isLoaded && status.didJustFinish) {
          void sound.unloadAsync().then(() => {
            void FileSystem.deleteAsync(file, { idempotent: true });
          });
          if (soundRef.current === sound) {
            soundRef.current = null;
            if (speakingRef.current) {
              speakingRef.current = false;
              setState("listening");
            }
          }
        }
      });
    } catch (err) {
      opts.onError(`播放失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [opts]);

  const start = useCallback((): void => {
    if (clientRef.current) return;
    setState("connecting");
    const client = new VoiceClient({
      onReady: () => setState("listening"),
      onUserUtterance: (text) => opts.onEvent({ kind: "user", text }),
      onReplyStart: () => setState("thinking"),
      onReply: (info) => opts.onEvent({ kind: "assistant", text: info.reply, chargedCents: info.chargedCents, balanceCredits: info.balanceCredits }),
      onAudioChunk: (chunk) => {
        pcmRef.current.push(new Uint8Array(chunk));
      },
      onAudioEnd: () => {
        setState("speaking");
        void playPcm();
      },
      onError: (message) => {
        opts.onError(message);
        setState("listening");
      },
      onEnded: () => {
        void stopPlayback();
        setState("off");
        clientRef.current = null;
      },
    });
    client.connect(token, scenarioId, sessionId);
    clientRef.current = client;
  }, [token, scenarioId, sessionId, opts, playPcm, stopPlayback]);

  const stop = useCallback((): void => {
    void stopPlayback();
    clientRef.current?.close();
    clientRef.current = null;
    setState("off");
  }, [stopPlayback]);

  const pushToTalkStart = useCallback(async (): Promise<void> => {
    if (!clientRef.current) {
      start();
      // 等 ready 再录，避免整段上传被"会话尚未开始"拒绝
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (clientRef.current?.isReady()) {
            clearInterval(check);
            resolve();
          }
        }, 150);
        setTimeout(() => { clearInterval(check); resolve(); }, 4000);
      });
    }
    await stopPlayback();
    pcmRef.current = [];
    try {
      // expo-av 要求显式请求麦克风权限（Expo Go 不自动弹）
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        opts.onError("麦克风权限被拒绝：请在系统设置 → 应用 → Expo Go → 权限中允许麦克风");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });
      const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
      recordingRef.current = recording;
      setState("listening");
    } catch (err) {
      opts.onError(`无法开始录音: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [opts, start, stopPlayback]);

  const pushToTalkEnd = useCallback(async (): Promise<void> => {
    const recording = recordingRef.current as Audio.Recording | null;
    recordingRef.current = null;
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true, shouldDuckAndroid: true });
      const uri = recording.getURI();
      if (!uri || !clientRef.current) return;
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      void FileSystem.deleteAsync(uri, { idempotent: true });
      setState("thinking");
      clientRef.current.sendAacBase64(base64);
    } catch (err) {
      opts.onError(`上传语音失败: ${err instanceof Error ? err.message : String(err)}`);
      setState("listening");
    }
  }, [opts]);

  useEffect(() => () => {
    void stopPlayback();
    clientRef.current?.close();
    void recordingRef.current?.stopAndUnloadAsync().catch(() => undefined);
  }, [stopPlayback]);

  return { state, start, stop, pushToTalkStart, pushToTalkEnd };
}

function bytesToBase64(bytes: Uint8Array): string {
  // RN 环境不保证 btoa（Hermes 版本差异），手写编码
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result += table[b0 >> 2];
    result += table[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    result += b1 === undefined ? "=" : table[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    result += b2 === undefined ? "=" : table[b2 & 63];
  }
  return result;
}
