import type { JSX } from "react";
/**
 * 闯关详情：初级=跟读判定（录音上传→ASR 匹配→领取奖励）；
 * 中级/高级=引导去对话，对话结束自动按轮数判定
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { ApiError, api, type ChallengeProgress } from "../../lib/api";
import { useAuth } from "../../lib/auth";

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: ".aac",
    outputFormat: Audio.AndroidOutputFormat.AAC_ADTS,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 48000,
  },
  ios: {
    extension: ".aac",
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 48000,
  },
  web: {},
};

export default function ChallengeDetail(): JSX.Element {
  const router = useRouter();
  const { token } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [challenge, setChallenge] = useState<ChallengeProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [verdict, setVerdict] = useState<{ text: string; display: string; ok: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token || !id) return;
    const lang = (id.startsWith("ja-") ? "ja" : id.startsWith("ko-") ? "ko" : "en") as "en" | "ja" | "ko";
    setLoading(true);
    api.challenges(token, lang)
      .then((res) => setChallenge(res.challenges.find((c) => c.id === id) ?? null))
      .catch((err: Error) => Alert.alert("加载失败", err.message))
      .finally(() => setLoading(false));
  }, [token, id]);

  const recordOnce = useCallback(async (): Promise<void> => {
    if (!token || !challenge || busy) return;
    setBusy(true);
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = recording ?? (await Audio.Recording.createAsync(RECORDING_OPTIONS)).recording;
      if (!recording) setRecording(rec);
      // 按住 3 秒节奏改为：开始录音后由「停止并判定」按钮收尾
      setRecording(rec);
    } catch (err) {
      Alert.alert("录音失败", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, challenge, busy, recording]);

  const stopAndJudge = useCallback(async (): Promise<void> => {
    if (!token || !challenge || !recording || busy) return;
    setBusy(true);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 400)); // 收尾编码器缓冲
      const uri = recording.getURI() ?? "";
      await recording.stopAndUnloadAsync();
      setRecording(null);
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const res = await api.challengeVoice(token, challenge.id, base64);
      setVerdict(res.results);
      if (res.matched < res.threshold) {
        Alert.alert("差一点！", `读对了 ${res.matched}/${res.results.length}，还需要 ${res.threshold - res.matched} 个。再试一次！`);
      }
    } catch (err) {
      Alert.alert("判定失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, challenge, recording, busy]);

  const claim = useCallback(async (): Promise<void> => {
    if (!token || !challenge || !verdict || busy) return;
    const matched = verdict.filter((v) => v.ok).length;
    setBusy(true);
    try {
      const res = await api.challengeClaim(token, challenge.id, matched);
      Alert.alert("🎉 闯关成功", `奖励 ${res.rewardedCents} 厘已入账\n余额：${res.balanceCredits} 积分`, [
        { text: "好的", onPress: () => router.back() },
      ]);
    } catch (err) {
      Alert.alert("领取失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, challenge, verdict, busy, router]);

  const startConversation = useCallback(async (): Promise<void> => {
    if (!token || !challenge) return;
    try {
      if (challenge.scenarioId) {
        const started = await api.startConversation(token, challenge.scenarioId);
        router.push({
          pathname: "/chat/[id]",
          params: { id: started.sessionId, opener: started.opener, title: started.scenario.title, scenarioId: challenge.scenarioId },
        });
      } else {
        router.push("/scenarios"); // 高级：任意情景皆可
      }
    } catch (err) {
      Alert.alert("开启失败", err instanceof ApiError ? err.message : String(err));
    }
  }, [token, challenge, router]);

  if (loading || !challenge) {
    return <View style={styles.center}><ActivityIndicator color="#8fd3ff" /></View>;
  }

  const matched = verdict?.filter((v) => v.ok).length ?? 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Text style={styles.title}>{challenge.title}</Text>
      <Text style={styles.desc}>{challenge.description}</Text>
      <View style={styles.rewardCard}>
        <Text style={styles.rewardText}>过关奖励 +{challenge.rewardCents} 厘</Text>
      </View>

      {challenge.words && (
        <>
          <Text style={styles.section}>按顺序朗读下面 {challenge.words.length} 个词（一次读完）</Text>
          {challenge.words.map((w, i) => (
            <View key={w.text} style={styles.wordRow}>
              <Text style={styles.wordIndex}>{i + 1}</Text>
              <Text style={styles.wordDisplay}>{w.display}</Text>
              {verdict && <Text style={styles.wordVerdict}>{verdict[i]?.ok ? "✅" : "❌"}</Text>}
            </View>
          ))}
          <Pressable
            style={[styles.bigBtn, (busy || !!recording) && styles.bigBtnOff]}
            disabled={busy}
            onPress={() => (recording ? void stopAndJudge() : void recordOnce())}
          >
            <Text style={styles.bigBtnText}>
              {recording ? "读完了 · 停止并判定" : busy ? "AI 听取中…" : "🎤 按下开始朗读"}
            </Text>
          </Pressable>
          {verdict && matched >= challenge.requiredTurns && (
            <Pressable style={[styles.bigBtn, styles.claimBtn]} disabled={busy} onPress={() => void claim()}>
              <Text style={styles.bigBtnText}>🎉 领取奖励 +{challenge.rewardCents} 厘</Text>
            </Pressable>
          )}
        </>
      )}

      {!challenge.words && (
        <Pressable style={styles.bigBtn} disabled={busy} onPress={() => void startConversation()}>
          <Text style={styles.bigBtnText}>💬 去对话（需 {challenge.requiredTurns} 轮，结束自动判定）</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c" },
  center: { flex: 1, backgroundColor: "#081a2c", alignItems: "center", justifyContent: "center" },
  title: { color: "#f2f7fa", fontSize: 20, fontWeight: "700" },
  desc: { color: "#7a92a8", fontSize: 13, lineHeight: 18 },
  rewardCard: { backgroundColor: "#0f2b22", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#2a6e4a" },
  rewardText: { color: "#7ee2a8", fontSize: 14, fontWeight: "700" },
  section: { color: "#9fb8c9", fontSize: 13, marginTop: 6 },
  wordRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#12314c", borderRadius: 10, padding: 12 },
  wordIndex: { color: "#5f7d92", fontSize: 13, width: 18 },
  wordDisplay: { color: "#f2f7fa", fontSize: 16, flex: 1 },
  wordVerdict: { fontSize: 16 },
  bigBtn: { backgroundColor: "#1a73e8", borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  bigBtnOff: { opacity: 0.5 },
  claimBtn: { backgroundColor: "#2a9d5c" },
  bigBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
