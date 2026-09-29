import type { JSX } from "react";
/**
 * 闯关进行中：混合题型（跟读/选择/判断/完形/造句/连线）一次一题、秒出对错
 * 答案判题在服务端；达标自动发奖
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [threshold, setThreshold] = useState(7);
  const [hits, setHits] = useState(0);
  const [streak, setStreak] = useState(0);
  const [feedback, setFeedback] = useState<null | { ok: boolean; correct?: string; why?: string }>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<null | { rewardCents: number; balance: string }>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [pendingUpload, setPendingUpload] = useState<null | { base64: string; wordIndex: number }>(null);
  const pressStartRef = useRef(0);
  // 造句 / 连线 本地选择状态
  const [buildOrder, setBuildOrder] = useState<number[]>([]);
  const [matchSel, setMatchSel] = useState<number | null>(null);
  const [matchLocked, setMatchLocked] = useState<Record<number, number>>({});
  const [matchWrong, setMatchWrong] = useState<number | null>(null);

  useEffect(() => {
    if (!token || !id) return;
    const lang = (id.startsWith("ja-") ? "ja" : id.startsWith("ko-") ? "ko" : "en") as "en" | "ja" | "ko";
    setLoading(true);
    Promise.all([api.challenges(token, lang), api.challengeExercises(token, id)])
      .then(([res, ex]) => {
        setChallenge(res.challenges.find((c) => c.id === id) ?? null);
        setExercises(ex.exercises);
        setThreshold(ex.threshold);
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
    setMatchLocked({});
    setMatchSel(null);
    setMatchWrong(null);
  }, []);

  const submit = useCallback(async (answer: unknown): Promise<void> => {
    if (!token || !id || busy || feedback) return;
    setBusy(true);
    try {
      const res = await api.challengeCheck(token, id, exIdx, answer);
      setFeedback(res);
      if (res.ok) {
        const newHits = hits + 1;
        if (challenge && newHits >= threshold) {
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
  }, [token, id, busy, feedback, exIdx, hits, challenge, threshold, nextExercise]);

  // ══ 听音辨词：TTS 播放 → 选听到的词 ══
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const playListen = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    const ex = exercises?.[exIdx];
    if (!ex || ex.type !== "listen") return;
    try {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, shouldDuckAndroid: false, playThroughEarpieceAndroid: false });
      const res = await api.challengeAudio(token, id, ex.wordIndex);
      await sound?.unloadAsync();
      const { sound: snd } = await Audio.Sound.createAsync({ uri: `data:audio/mpeg;base64,${res.audioBase64}` });
      setSound(snd);
      await snd.playAsync();
    } catch (err) {
      Alert.alert("播放失败", err instanceof ApiError ? err.message : String(err));
    }
  }, [token, id, exercises, exIdx, sound]);

  // ══ 听句选词：播放整句例句 ══
  const playCloze = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    const ex = exercises?.[exIdx];
    if (!ex || ex.type !== "cloze") return;
    try {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, shouldDuckAndroid: false, playThroughEarpieceAndroid: false });
      const res = await api.challengeAudio(token, id, ex.wordIndex, true);
      await sound?.unloadAsync();
      const { sound: snd } = await Audio.Sound.createAsync({ uri: `data:audio/mpeg;base64,${res.audioBase64}` });
      setSound(snd);
      await snd.playAsync();
    } catch (err) {
      Alert.alert("播放失败", err instanceof ApiError ? err.message : String(err));
    }
  }, [token, id, exercises, exIdx, sound]);

  // 听音题出现时自动播放一次
  useEffect(() => {
    const ex = exercises?.[exIdx];
    if (ex?.type === "listen") void playListen();
    if (ex?.type === "cloze") void playCloze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercises, exIdx]);

  // ══ 连线：逐对判定（对→灰锁；错→❗闪后重选） ══
  const tapLeft = useCallback((li: number): void => {
    if (matchLocked[li] !== undefined) return; // 已锁定不可再选
    setMatchSel((cur) => (cur === li ? null : li));
  }, [matchLocked]);

  const tapRight = useCallback(async (ri: number): Promise<void> => {
    if (!token || !id || matchSel === null || busy) return;
    if (Object.values(matchLocked).includes(ri)) return; // 已被正确配对占用的右侧
    setBusy(true);
    try {
      const res = await api.challengeCheckPair(token, id, exIdx, matchSel, ri);
      if (res.ok) {
        const locked = { ...matchLocked, [matchSel]: ri };
        setMatchLocked(locked);
        setMatchSel(null);
        // 全部配对成功 → 本题完成
        const ex = exercises?.[exIdx];
        if (ex && ex.type === "match" && Object.keys(locked).length === ex.left.length) {
          await submit(ex.left.map((_, li) => locked[li] ?? -1));
        }
      } else {
        setMatchWrong(matchSel); // ❗ 闪在左边（选错来源）
        setTimeout(() => setMatchWrong(null), 700);
        setMatchSel(null);
      }
    } catch (err) {
      Alert.alert("判定失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, id, matchSel, busy, matchLocked, exercises, exIdx, submit]);

  // ══ 跟读题：按住说话、松开判定；上传失败保留音频可重传（绝不丢录音） ══
  const uploadWord = useCallback(async (base64: string, wordIndex: number): Promise<void> => {
    if (!token || !id) return;
    setBusy(true);
    try {
      const res = await api.challengeWord(token, id, wordIndex, base64);
      setPendingUpload(null);
      setFeedback({ ok: res.ok, correct: res.ok ? undefined : `听成了「${res.transcript}」`, why: res.why });
      if (res.ok) {
        const newHits = hits + 1;
        if (challenge && newHits >= threshold) {
          const claim = await api.challengeClaim(token, challenge.id, newHits);
          setFinished({ rewardCents: claim.rewardedCents, balance: claim.balanceCredits });
          return;
        }
        setTimeout(() => nextExercise(true), 900);
      }
    } catch {
      // 上传/判定失败：保留音频，用户点重传（不必重说）
      setPendingUpload({ base64, wordIndex });
    } finally {
      setBusy(false);
    }
  }, [token, id, hits, challenge, threshold, nextExercise]);

  const readPressIn = useCallback(async (): Promise<void> => {
    if (!token || busy || feedback || pendingUpload) return;
    pressStartRef.current = Date.now();
    setBusy(true);
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true, shouldDuckAndroid: true, playThroughEarpieceAndroid: false });
      const { recording: rec } = await Audio.Recording.createAsync(REC);
      setRecording(rec);
      setFeedback(null);
    } catch (err) {
      Alert.alert("录音失败", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [token, busy, feedback, pendingUpload]);

  const readPressOut = useCallback(async (): Promise<void> => {
    const ex = exercises?.[exIdx];
    if (!ex || ex.type !== "read" || !recording) return;
    const heldMs = Date.now() - pressStartRef.current;
    setBusy(true);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 400)); // 编码器收尾缓冲
      const uri = recording.getURI() ?? "";
      await recording.stopAndUnloadAsync();
      setRecording(null);
      if (heldMs < 500) {
        setFeedback({ ok: false, why: "按住的时间太短——按住说话，松开判定" });
        setBusy(false);
        return;
      }
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      await uploadWord(base64, ex.wordIndex);
    } catch {
      setRecording(null);
      setBusy(false);
    }
  }, [exercises, exIdx, recording, uploadWord]);

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
        <Pressable style={styles.bigBtn} onPress={() => {
          void (async () => {
            if (!token || !challenge) { router.back(); return; }
            try {
              const lang = (challenge.id.startsWith("ja-") ? "ja" : challenge.id.startsWith("ko-") ? "ko" : "en") as "en" | "ja" | "ko";
              const res = await api.challenges(token, lang);
              const next = res.challenges.find((c) => c.state === "open");
              if (next) {
                router.replace({ pathname: "/challenge/[id]", params: { id: next.id } });
              } else {
                router.back();
              }
            } catch {
              router.back();
            }
          })();
        }}>
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
        <Text style={styles.partyBalance}>答对 {hits}/{threshold}，再来一轮（题目会重新洗牌顺序）</Text>
        <Pressable style={styles.bigBtn} onPress={() => {
          setExIdx(0); setHits(0); setStreak(0); setFeedback(null); setBuildOrder([]); setMatchLocked({}); setMatchSel(null);
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
        <Text style={styles.progressText}>{hits}/{threshold} 达标</Text>
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
        {ex.type === "listen" && (
          <View style={styles.card}>
            <Text style={styles.label}>听音辨词：AI 读的是哪个词？</Text>
            <Pressable style={styles.playBtn} disabled={busy || !!feedback} onPress={() => void playListen()}>
              <Text style={styles.playText}>🔊 再听一遍</Text>
            </Pressable>
          </View>
        )}
        {ex.type === "cloze" && (
          <View style={styles.card}>
            <Text style={styles.label}>听句选句：AI 读的是哪句话？</Text>
            <Pressable style={styles.playBtn} disabled={busy || !!feedback} onPress={() => void playCloze()}>
              <Text style={styles.playText}>🔊 再听一遍</Text>
            </Pressable>
          </View>
        )}
        {ex.type === "tf" && (
          <View style={styles.card}>
            <Text style={styles.label}>判断</Text>
            <Text style={styles.prompt}>{ex.prompt}</Text>
          </View>
        )}
        {ex.type === "build" && (
          <View style={styles.card}>
            <Text style={styles.label}>造句：把句子拼出来</Text>
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
                  <Pressable
                    key={li}
                    style={[
                      styles.matchItem,
                      matchSel === li && styles.matchItemSel,
                      matchLocked[li] !== undefined && styles.matchItemLocked,
                      matchWrong === li && styles.matchItemWrong,
                    ]}
                    onPress={() => tapLeft(li)}
                  >
                    <Text style={styles.matchText}>{matchWrong === li ? "❗ " : ""}{l}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.matchCol}>
                {ex.right.map((r, ri) => {
                  const lockedBy = Object.entries(matchLocked).find(([, v]) => v === ri);
                  return (
                    <Pressable
                      key={ri}
                      style={[
                        styles.matchItem,
                        matchSel !== null && matchLocked[matchSel] === undefined && styles.matchItemSel,
                        lockedBy !== undefined && styles.matchItemLocked,
                        matchWrong !== null && styles.matchItemWrongHint,
                      ]}
                      onPress={() => void tapRight(ri)}
                    >
                      <Text style={styles.matchText}>{lockedBy !== undefined ? "" : r}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>
        )}

        {feedback && (
          <View style={[styles.feedback, feedback.ok ? styles.feedbackOk : styles.feedbackMiss]}>
            <Text style={feedback.ok ? styles.feedbackOkText : styles.feedbackMissText}>
              {feedback.ok ? `✅ 对！` : `❌ ${feedback.correct ? `正确：${feedback.correct}` : "再想想"}`}
            </Text>
            {feedback.why && (
              <Text style={styles.whyText}>{feedback.why}</Text>
            )}
          </View>
        )}
      </ScrollView>

      {/* 操作区 */}
      {ex.type === "read" && (
        <Pressable
          style={[styles.micBtn, recording && styles.micBtnRec, busy && styles.micBtnBusy]}
          disabled={busy}
          onPressIn={() => void readPressIn()}
          onPressOut={() => void readPressOut()}
        >
          <Text style={styles.micText}>
            {busy ? "🤔 AI 听取中…" : recording ? "松开即判定" : "🎤 按住说话"}
          </Text>
        </Pressable>
      )}
      {ex.type === "read" && pendingUpload && (
        <Pressable style={[styles.micBtn, { backgroundColor: "#e08f3a" }]} disabled={busy} onPress={() => void uploadWord(pendingUpload.base64, pendingUpload.wordIndex)}>
          <Text style={styles.micText}>⚠️ 上传失败，点此重传（无需重说）</Text>
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
      {ex.type === "listen" && (
        <View style={styles.optionGrid}>
          {ex.options.map((o) => (
            <Pressable key={o} style={styles.optionBtn} disabled={busy || !!feedback} onPress={() => void submit(o)}>
              <Text style={[styles.optionText, { fontSize: 18, fontWeight: "700" }]}>{o}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {ex.type === "cloze" && (
        <View style={{ gap: 8 }}>
          {ex.options.map((o) => (
            <Pressable key={o} style={styles.sentenceBtn} disabled={busy || !!feedback} onPress={() => void submit(o)}>
              <Text style={styles.sentenceText}>{o}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {ex.type === "build" && (
        <Pressable style={[styles.micBtn, (busy || !!feedback) && styles.micBtnBusy]} disabled={busy || !!feedback || buildOrder.length === 0} onPress={() => void submit(buildOrder.map((ti) => ex.tiles[ti]!))}>
          <Text style={styles.micText}>提交句子</Text>
        </Pressable>
      )}
      {ex.type === "match" && (
        <Text style={styles.footnote}>全部配对正确后自动进入下一题</Text>
      )}
      {feedback && !feedback.ok && (
        <Pressable style={styles.nextBtn} onPress={() => nextExercise(false)}>
          <Text style={styles.nextText}>知道了 →</Text>
        </Pressable>
      )}
      {ex.type === "read" && !feedback && !recording && !busy && !pendingUpload && (
        <Pressable onPress={skipRead}>
          <Text style={styles.skipText}>跳过 →</Text>
        </Pressable>
      )}
      <Text style={styles.footnote}>第 {Math.min(exIdx + 1, total)}/{total} 题 · 答对 {threshold} 题过关</Text>
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
  playBtn: { alignSelf: "center", backgroundColor: "#1a73e8", borderRadius: 40, width: 110, height: 110, alignItems: "center", justifyContent: "center", marginTop: 6 },
  playText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  matchRow: { flexDirection: "row", gap: 10 },
  matchCol: { flex: 1, gap: 8 },
  matchItem: { borderRadius: 10, borderWidth: 1, borderColor: "#2a4a66", backgroundColor: "#0d2233", paddingVertical: 10, paddingHorizontal: 8, alignItems: "center" },
  matchItemSel: { borderColor: "#4da3ff", backgroundColor: "#153a5c" },
  matchItemLocked: { opacity: 0.3, borderColor: "#3a6b8f" },
  matchItemWrong: { borderColor: "#e05555", backgroundColor: "#2b1414" },
  matchItemWrongHint: { opacity: 0.9 },
  matchText: { color: "#f2f7fa", fontSize: 13, textAlign: "center" },
  feedback: { borderRadius: 12, padding: 12 },
  feedbackOk: { backgroundColor: "#0f2b22" },
  feedbackMiss: { backgroundColor: "#2b1414" },
  feedbackOkText: { color: "#7ee2a8", fontSize: 15, fontWeight: "700" },
  feedbackMissText: { color: "#e08f8f", fontSize: 14 },
  whyText: { color: "#9fb8c9", fontSize: 13, lineHeight: 19, marginTop: 4 },
  micBtn: { backgroundColor: "#1a73e8", borderRadius: 16, paddingVertical: 18, alignItems: "center" },
  micBtnRec: { backgroundColor: "#e05555" },
  micBtnBusy: { opacity: 0.6 },
  micText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  sentenceBtn: { backgroundColor: "#0d2233", borderRadius: 12, borderWidth: 2, borderColor: "#2a4a66", paddingVertical: 12, paddingHorizontal: 14 },
  sentenceText: { color: "#f2f7fa", fontSize: 15, lineHeight: 22 },
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
