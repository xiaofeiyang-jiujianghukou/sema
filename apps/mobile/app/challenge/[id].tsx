import type { JSX } from "react";
/**
 * 闯关进行中：混合题型（跟读/选择/判断/完形/造句/连线）一次一题、秒出对错
 * 答案判题在服务端；达标自动发奖
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { ApiError, api, type ChallengeProgress, type ChallengeWordInfo } from "../../lib/api";
import type { Exercise } from "../../lib/api.exercises";
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
  const [exercises, setExercises] = useState<Exercise[] | null>(null);
  const [loading, setLoading] = useState(true);

  const [exIdx, setExIdx] = useState(0);
  const [hits, setHits] = useState(0);
  const [streak, setStreak] = useState(0);
  const [feedback, setFeedback] = useState<null | { ok: boolean; correct?: string }>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<null | { rewardCents: number; balance: string }>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  // 造句 / 连线 本地选择状态
  const [buildOrder, setBuildOrder] = useState<number[]>([]);
  const [matchSel, setMatchSel] = useState<{ left: number; right: number } | null>(null);
  const [matchMap, setMatchMap] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!token || !id) return;
    const lang = (id.startsWith("ja-") ? "ja" : id.startsWith("ko-") ? "ko" : "en") as "en" | "ja" | "ko";
    setLoading(true);
    Promise.all([api.challenges(token, lang), api.challengeExercises(token, id)])
      .then(([res, ex]) => {
        setChallenge(res.challenges.find((c) => c.id === id) ?? null);
        setExercises(ex.exercises);
      })
      .catch((err: Error) => Alert.alert("加载失败", err.message))
      .finally(() => setLoading(false));
  }, [token, id]);

  const nextExercise = useCallback((ok: boolean): void => {
    if (ok) {
      setHits((h) => h + 1);
      setStreak((n) => n + 1);
    } else {
      setStreak(0);
    }
    setExIdx((i) => i + 1);
    setFeedback(null);
    setBuildOrder([]);
    setMatchMap({});
    setMatchSel(null);
  }, []);

  const submit = useCallback(async (answer: unknown): Promise<void> => {
    if (!token || !id || busy || feedback) return;
    setBusy(true);
    try {
      const res = await api.challengeCheck(token, id, exIdx, answer);
      setFeedback(res);
      if (res.ok) {
        const newHits = hits + 1;
        if (challenge && newHits >= challenge.requiredTurns) {
          const claim = await api.challengeClaim(token, challenge.id, newHits);
          setFinished({ rewardCents: claim.rewardedCents, balance: claim.balanceCredits });
          return;
        }
        setTimeout(() => nextExercise(true), 900);
      }
    } catch (err) {
      Alert.alert("判定失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, id, busy, feedback, exIdx, hits, challenge, nextExercise]);

  // ══ 跟读题：录音 → 单词判定 ══
  const readWord = useCallback(async (): Promise<void> => {
    if (!token || !id || busy || feedback) return;
    const ex = exercises?.[exIdx];
    if (!ex || ex.type !== "read") return;
    setBusy(true);
    try {
      if (!recording) {
        await Audio.requestPermissionsAsync();
        const { recording: rec } = await Audio.Recording.createAsync(REC);
        setRecording(rec);
        setFeedback(null);
        setBusy(false);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      const uri = recording.getURI() ?? "";
      await recording.stopAndUnloadAsync();
      setRecording(null);
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const res = await api.challengeWord(token, id, ex.wordIndex, base64);
      setFeedback({ ok: res.ok, correct: res.ok ? undefined : `听成了「${res.transcript}」` });
      if (res.ok) {
        const newHits = hits + 1;
        if (challenge && newHits >= challenge.requiredTurns) {
          const claim = await api.challengeClaim(token, challenge.id, newHits);
          setFinished({ rewardCents: claim.rewardedCents, balance: claim.balanceCredits });
          return;
        }
        setTimeout(() => nextExercise(true), 900);
      }
    } catch (err) {
      Alert.alert("判定失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, id, busy, feedback, exercises, exIdx, recording, hits, challenge, nextExercise]);

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
  if (!exercises) {
    return (
      <View style={styles.center}>
        <Text style={styles.dialogueGoal}>🎯 {challenge.description}</Text>
        <Pressable style={styles.bigBtn} onPress={() => {
          if (challenge.scenarioId) {
            void (async () => {
              try {
                const started = await api.startConversation(token!, challenge.scenarioId!);
                router.push({ pathname: "/chat/[id]", params: { id: started.sessionId, opener: started.opener, title: started.scenario.title, scenarioId: challenge.scenarioId } });
              } catch (err) {
                Alert.alert("开启失败", err instanceof ApiError ? err.message : String(err));
              }
            })();
          } else {
            router.push("/scenarios");
          }
        }}>
          <Text style={styles.bigBtnText}>开始对话</Text>
        </Pressable>
      </View>
    );
  }

  const ex = exercises[exIdx];
  if (!ex) {
    // 题目做完未达标 → 重开本关
    return (
      <View style={styles.center}>
        <Text style={styles.partyTitle}>还差一点！</Text>
        <Text style={styles.partyBalance}>答对 {hits}/{challenge.requiredTurns}，再来一轮（题目会重新洗牌顺序）</Text>
        <Pressable style={styles.bigBtn} onPress={() => {
          setExIdx(0); setHits(0); setStreak(0); setFeedback(null); setBuildOrder([]); setMatchMap({}); setMatchSel(null);
          void (async () => {
            if (!token || !id) return;
            const ex2 = await api.challengeExercises(token, id);
            setExercises(ex2.exercises);
          })();
        }}>
          <Text style={styles.bigBtnText}>再来一轮</Text>
        </Pressable>
      </View>
    );
  }

  const total = exercises.length;
  const wordInfo = (i: number): ChallengeWordInfo | undefined => challenge.words?.[i];

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.progressText}>{hits}/{challenge.requiredTurns} 达标</Text>
        {streak >= 2 && <Text style={styles.streak}>🔥 连对 {streak}</Text>}
      </View>
      <View style={styles.dots}>
        {exercises.map((_, i) => (
          <View key={i} style={[styles.dot, i < exIdx && styles.dotPast, i === exIdx && styles.dotNow]} />
        ))}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10 }}>
        {ex.type === "read" && (
          <View style={styles.card}>
            <Text style={styles.label}>🎤 跟读</Text>
            <Text style={styles.bigWord}>{ex.word}</Text>
            <Text style={styles.subWord}>{ex.display.split(" · ").slice(1).join(" · ")}</Text>
          </View>
        )}
        {ex.type === "mc" && (
          <View style={styles.card}>
            <Text style={styles.label}>选择</Text>
            <Text style={styles.prompt}>{ex.prompt}</Text>
          </View>
        )}
        {ex.type === "tf" && (
          <View style={styles.card}>
            <Text style={styles.label}>判断</Text>
            <Text style={styles.prompt}>{ex.prompt}</Text>
          </View>
        )}
        {ex.type === "cloze" && (
          <View style={styles.card}>
            <Text style={styles.label}>完形填空</Text>
            <Text style={styles.prompt}>{ex.sentence}</Text>
          </View>
        )}
        {ex.type === "build" && (
          <View style={styles.card}>
            <Text style={styles.label}>造句：把句子排出来</Text>
            <View style={styles.buildArea}>
              {buildOrder.length === 0 && <Text style={styles.subWord}>点下面的词块组句子</Text>}
              {buildOrder.map((ti, i) => (
                <Pressable key={`${ti}-${i}`} style={styles.tileOn} onPress={() => setBuildOrder((o) => o.filter((_, j) => j !== i))}>
                  <Text style={styles.tileText}>{ex.tiles[ti]}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.tileRow}>
              {ex.tiles.map((t, i) => (
                <Pressable key={`${t}-${i}`} style={[styles.tile, buildOrder.includes(i) && styles.tileUsed]} onPress={() => { if (!buildOrder.includes(i)) setBuildOrder((o) => [...o, i]); }}>
                  <Text style={styles.tileText}>{t}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.subWord}>提示：{ex.hint}</Text>
          </View>
        )}
        {ex.type === "match" && (
          <View style={styles.card}>
            <Text style={styles.label}>连线：先点左边的词，再点右边释义</Text>
            <View style={styles.matchRow}>
              <View style={styles.matchCol}>
                {ex.left.map((l, li) => (
                  <Pressable key={li} style={[styles.matchItem, matchSel?.left === li && styles.matchItemSel, matchMap[li] !== undefined && styles.matchItemDone]} onPress={() => setMatchSel({ left: li, right: -1 })}>
                    <Text style={styles.matchText}>{l}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.matchCol}>
                {ex.right.map((r, ri) => (
                  <Pressable key={ri} style={[styles.matchItem, matchMap[matchSel?.left ?? -1] === ri && styles.matchItemSel]} onPress={() => {
                    if (!matchSel) return;
                    setMatchMap((m) => ({ ...m, [matchSel.left]: ri }));
                    setMatchSel(null);
                  }}>
                    <Text style={styles.matchText}>{r}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        )}

        {feedback && (
          <View style={[styles.feedback, feedback.ok ? styles.feedbackOk : styles.feedbackMiss]}>
            <Text style={feedback.ok ? styles.feedbackOkText : styles.feedbackMissText}>
              {feedback.ok ? "✅ 过！" : `❌ ${feedback.correct ? `正确：${feedback.correct}` : "再想想"}`}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* 操作区 */}
      {ex.type === "read" && (
        <Pressable style={[styles.micBtn, recording && styles.micBtnRec, busy && styles.micBtnBusy]} disabled={busy} onPress={() => void readWord()}>
          <Text style={styles.micText}>{busy ? "🤔 AI 听取中…" : recording ? "说完点这里" : "🎤 说这个词"}</Text>
        </Pressable>
      )}
      {ex.type === "mc" && (
        <View style={styles.optionGrid}>
          {ex.options.map((o) => (
            <Pressable key={o} style={styles.optionBtn} disabled={busy || !!feedback} onPress={() => void submit(o)}>
              <Text style={styles.optionText}>{o}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {ex.type === "tf" && (
        <View style={styles.optionGrid}>
          <Pressable style={styles.optionBtn} disabled={busy || !!feedback} onPress={() => void submit(true)}>
            <Text style={styles.optionText}>✓ 对</Text>
          </Pressable>
          <Pressable style={styles.optionBtn} disabled={busy || !!feedback} onPress={() => void submit(false)}>
            <Text style={styles.optionText}>✗ 错</Text>
          </Pressable>
        </View>
      )}
      {ex.type === "cloze" && (
        <View style={styles.optionGrid}>
          {ex.options.map((o) => (
            <Pressable key={o} style={styles.optionBtn} disabled={busy || !!feedback} onPress={() => void submit(o)}>
              <Text style={styles.optionText}>{o}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {ex.type === "build" && (
        <Pressable style={[styles.micBtn, (busy || !!feedback) && styles.micBtnBusy]} disabled={busy || !!feedback || buildOrder.length === 0} onPress={() => void submit(buildOrder.map((ti) => ex.tiles[ti]))}>
          <Text style={styles.micText}>提交句子</Text>
        </Pressable>
      )}
      {ex.type === "match" && (
        <Pressable style={[styles.micBtn, (busy || !!feedback) && styles.micBtnBusy]} disabled={busy || !!feedback || Object.keys(matchMap).length < ex.left.length} onPress={() => void submit(ex.left.map((_, li) => matchMap[li] ?? -1))}>
          <Text style={styles.micText}>完成连线</Text>
        </Pressable>
      )}
      {feedback && !feedback.ok && (
        <Pressable style={styles.nextBtn} onPress={() => nextExercise(false)}>
          <Text style={styles.nextText}>知道了 →</Text>
        </Pressable>
      )}
      {ex.type === "read" && !feedback && !recording && !busy && (
        <Pressable onPress={skipRead}>
          <Text style={styles.skipText}>跳过 →</Text>
        </Pressable>
      )}
      <Text style={styles.footnote}>第 {Math.min(exIdx + 1, total)}/{total} 题 · 答对 {challenge.requiredTurns} 题过关</Text>
    </View>
  );

  function skipRead(): void {
    setStreak(0);
    setExIdx((i) => i + 1);
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c", padding: 20, paddingTop: 44, gap: 10 },
  center: { flex: 1, backgroundColor: "#081a2c", alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  progressText: { color: "#f2f7fa", fontSize: 15, fontWeight: "700" },
  streak: { color: "#ffb84d", fontSize: 14, fontWeight: "700" },
  dots: { flexDirection: "row", gap: 4, flexWrap: "wrap" },
  dot: { width: 14, height: 6, borderRadius: 3, backgroundColor: "#1f3d55" },
  dotPast: { backgroundColor: "#3a6b8f" },
  dotNow: { backgroundColor: "#4da3ff" },
  card: { backgroundColor: "#12314c", borderRadius: 16, padding: 18, gap: 8 },
  label: { color: "#5f9ec7", fontSize: 12, fontWeight: "700" },
  bigWord: { color: "#f2f7fa", fontSize: 40, fontWeight: "800" },
  subWord: { color: "#9fb8c9", fontSize: 14 },
  prompt: { color: "#f2f7fa", fontSize: 19, lineHeight: 28 },
  buildArea: { flexDirection: "row", flexWrap: "wrap", gap: 6, minHeight: 44, alignItems: "center" },
  tileRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tile: { backgroundColor: "#0d2233", borderRadius: 8, borderWidth: 1, borderColor: "#2a4a66", paddingHorizontal: 10, paddingVertical: 6 },
  tileUsed: { opacity: 0.3 },
  tileOn: { backgroundColor: "#1a73e8", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  tileText: { color: "#f2f7fa", fontSize: 14 },
  matchRow: { flexDirection: "row", gap: 10 },
  matchCol: { flex: 1, gap: 8 },
  matchItem: { borderRadius: 10, borderWidth: 1, borderColor: "#2a4a66", backgroundColor: "#0d2233", paddingVertical: 10, paddingHorizontal: 8, alignItems: "center" },
  matchItemSel: { borderColor: "#4da3ff", backgroundColor: "#153a5c" },
  matchItemDone: { opacity: 0.45 },
  matchText: { color: "#f2f7fa", fontSize: 13, textAlign: "center" },
  feedback: { borderRadius: 12, padding: 12 },
  feedbackOk: { backgroundColor: "#0f2b22" },
  feedbackMiss: { backgroundColor: "#2b1414" },
  feedbackOkText: { color: "#7ee2a8", fontSize: 15, fontWeight: "700" },
  feedbackMissText: { color: "#e08f8f", fontSize: 14 },
  micBtn: { backgroundColor: "#1a73e8", borderRadius: 16, paddingVertical: 18, alignItems: "center" },
  micBtnRec: { backgroundColor: "#e05555" },
  micBtnBusy: { opacity: 0.6 },
  micText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  optionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionBtn: { flexGrow: 1, flexBasis: "47%", backgroundColor: "#0d2233", borderRadius: 12, borderWidth: 2, borderColor: "#2a4a66", paddingVertical: 14, paddingHorizontal: 10, alignItems: "center" },
  optionText: { color: "#f2f7fa", fontSize: 14, textAlign: "center" },
  nextBtn: { alignItems: "center", paddingVertical: 4 },
  nextText: { color: "#4da3ff", fontSize: 15, fontWeight: "700" },
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
