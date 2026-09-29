import type { JSX } from "react";
/**
 * 课程主页：当前课程（按考级大纲的第一册）+ 单元课程表 + 闯关进度
 * 关卡由课程内容派生：每单元 = 词表跟读关 + 对话应用关，进度顺序解锁
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, api, type ChallengeProgress, type PublicUser } from "../lib/api";
import { useAuth } from "../lib/auth";

const LANGS: Record<"en" | "ja" | "ko", { label: string; flag: string; course: string }> = {
  en: { label: "英语", flag: "🇬🇧", course: "CEFR A1" },
  ja: { label: "日语", flag: "🇯🇵", course: "JLPT N5" },
  ko: { label: "韩语", flag: "🇰🇷", course: "TOPIK I" },
};

const LEVEL_LABEL: Record<string, string> = { zero: "零基础", basic: "入门", pro: "进阶" };

export default function Course(): JSX.Element {
  const router = useRouter();
  const { token, user, updateUser } = useAuth();
  const [lang, setLang] = useState<"en" | "ja" | "ko">(user?.targetLang ?? "en");
  const [challenges, setChallenges] = useState<ChallengeProgress[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (l: "en" | "ja" | "ko"): Promise<void> => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await api.challenges(token, l);
      setChallenges(res.challenges);
    } catch (err) {
      Alert.alert("加载失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load(lang);
  }, [lang, load]);

  const switchCourse = async (l: "en" | "ja" | "ko"): Promise<void> => {
    if (!token || l === lang) return;
    setLang(l);
    if (user) {
      try {
        const updated = await api.updateMe(token, { targetLang: l });
        updateUser(updated as PublicUser);
      } catch {
        // 切课失败不阻断浏览
      }
    }
  };

  const level = user?.levels?.[lang];
  const nextLesson = challenges?.find((c) => c.state === "open");
  const doneCount = challenges?.filter((c) => c.state === "completed").length ?? 0;

  let lastGroup = "";

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}>
      {/* 课程切换：横向滚动 chips，可扩展任意多门课程 */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.langRow}>
        {(Object.keys(LANGS) as Array<"en" | "ja" | "ko">).map((l) => (
          <Pressable key={l} style={[styles.langBtn, lang === l && styles.langBtnOn]} onPress={() => void switchCourse(l)}>
            <Text style={styles.langFlag}>{LANGS[l].flag}</Text>
            <Text style={[styles.langLabel, lang === l && styles.langLabelOn]}>{LANGS[l].label}</Text>
            <Text style={styles.langCourse}>{LANGS[l].course}</Text>
            {user?.levels?.[l] && <Text style={styles.langLevel}>{LEVEL_LABEL[user.levels[l]!]}</Text>}
          </Pressable>
        ))}
        <Pressable style={styles.langBtnMore} onPress={() => Alert.alert("更多课程", "法语 / 西语 / 德语等课程陆续开放，敬请期待。")}>
          <Text style={styles.langFlag}>＋</Text>
          <Text style={styles.langLabel}>更多</Text>
        </Pressable>
      </ScrollView>

      {/* 课程进度 + 继续学习 */}
      {challenges && challenges.length > 0 && (
        <View style={styles.progressCard}>
          <Text style={styles.progressText}>
            {LANGS[lang].course} 第一册 · 已过 {doneCount}/{challenges.length} 关
          </Text>
          {nextLesson ? (
            <Pressable style={styles.continueBtn} onPress={() => router.push({ pathname: "/challenge/[id]", params: { id: nextLesson.id } })}>
              <Text style={styles.continueText}>继续学习：{nextLesson.title}</Text>
            </Pressable>
          ) : (
            <Text style={styles.progressText}>🎉 第一册全部通关！第二册筹备中</Text>
          )}
        </View>
      )}

      {loading && <ActivityIndicator color="#8fd3ff" style={{ marginTop: 24 }} />}

      {challenges?.map((c) => {
        const showHeader = c.group !== lastGroup;
        lastGroup = c.group;
        return (
          <View key={c.id}>
            {showHeader && (
              <View style={styles.unitHeader}>
                <Text style={styles.unitTitle}>{c.group}</Text>
              </View>
            )}
            <Pressable
              style={[styles.card, c.state === "completed" && styles.cardDone, c.state === "locked" && styles.cardLocked]}
              onPress={() => {
                if (c.state === "locked") return;
                router.push({ pathname: "/challenge/[id]", params: { id: c.id } });
              }}
            >
              <Text style={styles.stateIcon}>{c.state === "completed" ? "✅" : c.state === "locked" ? "🔒" : "▶️"}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardTitle, c.state === "locked" && styles.dimText]}>{c.title}</Text>
                <Text style={[styles.cardDesc, c.state === "locked" && styles.dimText]}>{c.description}</Text>
              </View>
              <Text style={styles.reward}>+{c.rewardCents}厘</Text>
            </Pressable>
          </View>
        );
      })}

      <Pressable style={styles.browseBtn} onPress={() => router.push("/scenarios")}>
        <Text style={styles.browseText}>自由练习（全部情景）→</Text>
      </Pressable>
      <Text style={styles.footnote}>
        {level ? `你的水平：${LEVEL_LABEL[level] ?? level}——课程按大纲顺序推进，AI 辅助强度跟随水平` : "这门课还没定水平——去「我的」设置，AI 才好拿捏难度"}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c" },
  langRow: { flexDirection: "row", gap: 8, paddingRight: 16 },
  langBtn: { width: 92, borderRadius: 12, borderWidth: 2, borderColor: "#1f3d55", backgroundColor: "#0d2233", paddingVertical: 10, alignItems: "center", gap: 2 },
  langBtnMore: { width: 92, borderRadius: 12, borderWidth: 2, borderStyle: "dashed", borderColor: "#2a4a66", backgroundColor: "transparent", paddingVertical: 10, alignItems: "center", gap: 2 },
  langBtnOn: { borderColor: "#1a73e8", backgroundColor: "#153a5c" },
  langFlag: { fontSize: 22 },
  langLabel: { color: "#9fb8c9", fontSize: 13 },
  langLabelOn: { color: "#f2f7fa", fontWeight: "700" },
  langCourse: { color: "#5f7d92", fontSize: 10 },
  langLevel: { color: "#7ee2a8", fontSize: 10 },
  progressCard: { backgroundColor: "#12314c", borderRadius: 12, padding: 14, gap: 10 },
  progressText: { color: "#9fb8c9", fontSize: 13 },
  continueBtn: { backgroundColor: "#1a73e8", borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  continueText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  unitHeader: { marginTop: 8, paddingBottom: 6, borderBottomWidth: 1, borderColor: "#1f3d55" },
  unitTitle: { color: "#f2f7fa", fontSize: 14, fontWeight: "700" },
  card: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#12314c", borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "transparent" },
  cardDone: { borderColor: "#2a6e4a", backgroundColor: "#0f2b22" },
  cardLocked: { opacity: 0.5 },
  stateIcon: { fontSize: 20 },
  cardTitle: { color: "#f2f7fa", fontSize: 14, fontWeight: "600" },
  cardDesc: { color: "#7a92a8", fontSize: 11, marginTop: 2, lineHeight: 15 },
  dimText: { color: "#5f7d92" },
  reward: { color: "#7ee2a8", fontSize: 13, fontWeight: "700" },
  browseBtn: { alignItems: "center", paddingVertical: 12 },
  browseText: { color: "#4da3ff", fontSize: 13 },
  footnote: { color: "#5f7d92", fontSize: 11, lineHeight: 16, textAlign: "center" },
});
