import type { JSX } from "react";
/**
 * 课程主页：当前课程 + 三级学习路径（初级跟读 / 中级情景 / 高级自由语音）+ 闯关进度
 * 登录后默认进入（上次课程），没学过的用户先走引导
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { ApiError, api, type ChallengeProgress, type PublicUser } from "../lib/api";
import { useAuth } from "../lib/auth";

const LANGS: Record<"en" | "ja" | "ko", { label: string; flag: string }> = {
  en: { label: "英语", flag: "🇬🇧" },
  ja: { label: "日语", flag: "🇯🇵" },
  ko: { label: "韩语", flag: "🇰🇷" },
};

const LEVEL_LABEL: Record<string, string> = { zero: "零基础", basic: "入门", pro: "进阶" };

const TIERS: Array<{ key: ChallengeProgress["tier"]; label: string; emoji: string; desc: string }> = [
  { key: "beginner", label: "初级 · 单词句子", emoji: "🌱", desc: "看词开口读，AI 听你读得对不对" },
  { key: "intermediate", label: "中级 · 情景对话", emoji: "💬", desc: "真实场景完成对话轮数" },
  { key: "advanced", label: "高级 · 自由语音", emoji: "🚀", desc: "真实语速自由对话（视频通话即将推出）" },
];

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

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      {/* 课程切换 */}
      <View style={styles.langRow}>
        {(Object.keys(LANGS) as Array<"en" | "ja" | "ko">).map((l) => (
          <Pressable key={l} style={[styles.langBtn, lang === l && styles.langBtnOn]} onPress={() => void switchCourse(l)}>
            <Text style={styles.langFlag}>{LANGS[l].flag}</Text>
            <Text style={[styles.langLabel, lang === l && styles.langLabelOn]}>{LANGS[l].label}</Text>
            {user?.levels?.[l] && <Text style={styles.langLevel}>{LEVEL_LABEL[user.levels[l]!]}</Text>}
          </Pressable>
        ))}
      </View>
      <Text style={styles.hint}>
        {level
          ? `当前水平：${LEVEL_LABEL[level] ?? level} · 已为你点亮推荐的闯关路径`
          : "这门课还没定水平——去「我的」设置，AI 才好拿捏难度"}
      </Text>

      {loading && <ActivityIndicator color="#8fd3ff" style={{ marginTop: 24 }} />}

      {challenges?.map((c) => {
        const tier = TIERS.find((t) => t.key === c.tier)!;
        const isRecommended =
          (level === "zero" && c.tier === "beginner") ||
          (level === "basic" && c.tier === "intermediate") ||
          (level === "pro" && c.tier === "advanced");
        const showHeader = c.order === 1;
        return (
          <View key={c.id}>
            {showHeader && (
              <View style={[styles.tierHeader, isRecommended && styles.tierHeaderOn]}>
                <Text style={styles.tierTitle}>{tier.emoji} {tier.label}{isRecommended ? " · 推荐路径" : ""}</Text>
                <Text style={styles.tierDesc}>{tier.desc}</Text>
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
        <Text style={styles.browseText}>浏览全部情景（自由练习）→</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c" },
  langRow: { flexDirection: "row", gap: 8 },
  langBtn: { flex: 1, borderRadius: 12, borderWidth: 2, borderColor: "#1f3d55", backgroundColor: "#0d2233", paddingVertical: 10, alignItems: "center", gap: 2 },
  langBtnOn: { borderColor: "#1a73e8", backgroundColor: "#153a5c" },
  langFlag: { fontSize: 22 },
  langLabel: { color: "#9fb8c9", fontSize: 13 },
  langLabelOn: { color: "#f2f7fa", fontWeight: "700" },
  langLevel: { color: "#7ee2a8", fontSize: 10 },
  hint: { color: "#7a92a8", fontSize: 12, lineHeight: 17 },
  tierHeader: { marginTop: 8, marginBottom: 8, paddingBottom: 6, borderBottomWidth: 1, borderColor: "#1f3d55" },
  tierHeaderOn: { borderColor: "#1a73e8" },
  tierTitle: { color: "#f2f7fa", fontSize: 15, fontWeight: "700" },
  tierDesc: { color: "#7a92a8", fontSize: 11, marginTop: 2 },
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
});
