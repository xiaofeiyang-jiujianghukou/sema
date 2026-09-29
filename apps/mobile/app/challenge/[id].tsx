import type { JSX } from "react";
/**
 * 闯关进行中：游戏化一关一分钟
 * 跟读关 = 一次一个词 → 点话筒 → 说 → 秒出对错 → 自动下一个；达标自动发奖
 * 对话关 = 一个按钮进对话，结束自动判定
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { ApiError, api, type ChallengeProgress } from "../../lib/api";
import { useAuth } from "../../lib/auth";

const REC: Audio.RecordingOptions = {
  android: { extension: ".aac", outputFormat: Audio.AndroidOutputFormat.AAC_ADTS, audioEncoder: Audio.AndroidAudioEncoder.AAC, sampleRate: 16000, numberOfChannels: 1, bitRate: 48000 },
  ios: { extension: ".aac", outputFormat: Audio.IOSOutputFormat.MPEG4AAC, audioQuality: Audio.IOSAudioQuality.MEDIUM, sampleRate: 16000, numberOfChannels: 1, bitRate: 48000 },
  web: {},
};

export default function ChallengePlay(): JSX.Element {
  const router = useRouter();
  const { token } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [challenge, setChallenge] = useState<ChallengeProgress | null>(null);
  const [loading, setLoading] = useState(true);

  // 跟读关状态
  const [idx, setIdx] = useState(0);
  const [hits, setHits] = useState(0);
  const [streak, setStreak] = useState(0);
  const [lastVerdict, setLastVerdict] = useState<null | { ok: boolean; transcript: string }>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<null | { rewardCents: number; balance: string }>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);

  useEffect(() => {
    if (!token || !id) return;
    const lang = (id.startsWith("ja-") ? "ja" : id.startsWith("ko-") ? "ko" : "en") as "en" | "ja" | "ko";
    setLoading(true);
    api.challenges(token, lang)
      .then((res) => setChallenge(res.challenges.find((c) => c.id === id) ?? null))
      .catch((err: Error) => Alert.alert("加载失败", err.message))
      .finally(() => setLoading(false));
  }, [token, id]);

  const finish = useCallback(async (totalHits: number): Promise<void> => {
    if (!token || !challenge) return;
    try {
      const res = await api.challengeClaim(token, challenge.id, totalHits);
      setFinished({ rewardCents: res.rewardedCents, balance: res.balanceCredits });
    } catch (err) {
      Alert.alert("领取失败", err instanceof ApiError ? err.message : String(err));
    }
  }, [token, challenge]);

  const sayWord = useCallback(async (): Promise<void> => {
    if (!token || !challenge || busy || finished || !challenge.words) return;
    setBusy(true);
    try {
      await Audio.requestPermissionsAsync();
      const { recording: rec } = await Audio.Recording.createAsync(REC);
      setRecording(rec);
      setLastVerdict(null);
    } catch (err) {
      Alert.alert("录音失败", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, challenge, busy, finished]);

  const judge = useCallback(async (): Promise<void> => {
    if (!token || !challenge || !recording || busy || finished || !challenge.words) return;
    setBusy(true);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 350)); // 收尾编码器缓冲
      const uri = recording.getURI() ?? "";
      await recording.stopAndUnloadAsync();
      setRecording(null);
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const res = await api.challengeWord(token, challenge.id, idx, base64);
      setLastVerdict(res);
      if (res.ok) {
        const newHits = hits + 1;
        setHits(newHits);
        setStreak((n) => n + 1);
        if (newHits >= challenge.requiredTurns) {
          await finish(newHits);
          return;
        }
        setIdx((i) => Math.min(i + 1, challenge.words!.length - 1));
      } else {
        setStreak(0);
      }
    } catch (err) {
      Alert.alert("判定失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, challenge, recording, busy, finished, idx, hits, finish]);

  const skip = useCallback((): void => {
    if (!challenge?.words) return;
    setStreak(0);
    setIdx((i) => Math.min(i + 1, challenge.words!.length - 1));
    setLastVerdict(null);
  }, [challenge]);

  const startConversation = useCallback(async (): Promise<void> => {
    if (!token || !challenge) return;
    try {
      if (challenge.scenarioId) {
        const started = await api.startConversation(token, challenge.scenarioId);
        router.push({ pathname: "/chat/[id]", params: { id: started.sessionId, opener: started.opener, title: started.scenario.title, scenarioId: challenge.scenarioId } });
      } else {
        router.push("/scenarios");
      }
    } catch (err) {
      Alert.alert("开启失败", err instanceof ApiError ? err.message : String(err));
    }
  }, [token, challenge, router]);

  if (loading || !challenge) {
    return <View style={styles.center}><ActivityIndicator color="#8fd3ff" /></View>;
  }

  // ══ 过关庆祝页 ══
  if (finished) {
    return (
      <View style={styles.center}>
        <Text style={styles.party}>🎉</Text>
        <Text style={styles.partyTitle}>闯关成功！</Text>
        <Text style={styles.partyReward}>+{finished.rewardCents} 厘已入账</Text>
        <Text style={styles.partyBalance}>余额 {finished.balance} 积分</Text>
        <Pressable style={styles.bigBtn} onPress={() => router.back()}>
          <Text style={styles.bigBtnText}>继续下一关 →</Text>
        </Pressable>
      </View>
    );
  }

  // ══ 对话应用关 ══
  if (!challenge.words) {
    return (
      <View style={styles.center}>
        <Text style={styles.dialogueGoal}>🎯 {challenge.description}</Text>
        <Pressable style={styles.bigBtn} onPress={() => void startConversation()}>
          <Text style={styles.bigBtnText}>开始对话</Text>
        </Pressable>
      </View>
    );
  }

  // ══ 跟读关：一次一个词 ══
  const word = challenge.words[idx]!;
  const total = challenge.words.length;
  const need = challenge.requiredTurns;

  return (
    <View style={styles.container}>
      {/* 进度：达标数 + 连击 */}
      <View style={styles.topRow}>
        <Text style={styles.progressText}>{hits}/{need} 达标</Text>
        {streak >= 2 && <Text style={styles.streak}>🔥 连对 {streak}</Text>}
      </View>
      <View style={styles.dots}>
        {challenge.words.map((_, i) => (
          <View key={i} style={[styles.dot, i < idx && styles.dotPast, i === idx && styles.dotNow]} />
        ))}
      </View>

      {/* 词卡 */}
      <View style={[styles.wordCard, lastVerdict && !lastVerdict.ok && styles.wordCardMiss]}>
        <Text style={styles.wordTerm}>{word.text}</Text>
        <Text style={styles.wordMeaning}>{word.display.split(" · ").slice(1).join(" · ")}</Text>
        {lastVerdict && (
          <Text style={lastVerdict.ok ? styles.verdictOk : styles.verdictMiss}>
            {lastVerdict.ok ? "✅ 过！" : `❌ 听成了「${lastVerdict.transcript}」再说一次`}
          </Text>
        )}
      </View>

      {/* 主按钮：说 / 判定中 */}
      <Pressable
        style={[styles.micBtn, recording && styles.micBtnRec, busy && styles.micBtnBusy]}
        disabled={busy}
        onPress={() => (recording ? void judge() : void sayWord())}
      >
        <Text style={styles.micText}>
          {busy ? "🤔 AI 听取中…" : recording ? "说完点这里" : "🎤 说这个词"}
        </Text>
      </Pressable>
      <Pressable onPress={skip}>
        <Text style={styles.skipText}>跳过这个词 →</Text>
      </Pressable>
      <Text style={styles.footnote}>共 {total} 词，达标 {need} 个即过关</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c", padding: 20, paddingTop: 48, gap: 14 },
  center: { flex: 1, backgroundColor: "#081a2c", alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  progressText: { color: "#f2f7fa", fontSize: 15, fontWeight: "700" },
  streak: { color: "#ffb84d", fontSize: 14, fontWeight: "700" },
  dots: { flexDirection: "row", gap: 5, flexWrap: "wrap" },
  dot: { width: 18, height: 6, borderRadius: 3, backgroundColor: "#1f3d55" },
  dotPast: { backgroundColor: "#3a6b8f" },
  dotNow: { backgroundColor: "#4da3ff" },
  wordCard: { flex: 1, backgroundColor: "#12314c", borderRadius: 20, alignItems: "center", justifyContent: "center", gap: 12, borderWidth: 3, borderColor: "transparent" },
  wordCardMiss: { borderColor: "#8f3a3a" },
  wordTerm: { color: "#f2f7fa", fontSize: 44, fontWeight: "800" },
  wordMeaning: { color: "#9fb8c9", fontSize: 16 },
  verdictOk: { color: "#7ee2a8", fontSize: 15, fontWeight: "700" },
  verdictMiss: { color: "#e08f8f", fontSize: 13, textAlign: "center", paddingHorizontal: 16 },
  micBtn: { backgroundColor: "#1a73e8", borderRadius: 18, paddingVertical: 20, alignItems: "center" },
  micBtnRec: { backgroundColor: "#e05555" },
  micBtnBusy: { opacity: 0.6 },
  micText: { color: "#fff", fontSize: 17, fontWeight: "800" },
  skipText: { color: "#5f7d92", fontSize: 13, textAlign: "center" },
  footnote: { color: "#5f7d92", fontSize: 11, textAlign: "center" },
  party: { fontSize: 72 },
  partyTitle: { color: "#f2f7fa", fontSize: 26, fontWeight: "800" },
  partyReward: { color: "#7ee2a8", fontSize: 18, fontWeight: "700" },
  partyBalance: { color: "#7a92a8", fontSize: 13 },
  dialogueGoal: { color: "#f2f7fa", fontSize: 16, lineHeight: 24, textAlign: "center" },
  bigBtn: { backgroundColor: "#1a73e8", borderRadius: 14, paddingVertical: 16, paddingHorizontal: 40, alignItems: "center" },
  bigBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
