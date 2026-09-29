import type { JSX } from "react";
/**
 * 新手引导：先选学什么语言，再定当前水平 → 按水平进情景列表（推荐排序）
 * 触发条件：登录后 user.level 为空（首次使用，或老用户升级后首次进入）
 */
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, api, type PublicUser } from "../lib/api";
import { useAuth } from "../lib/auth";

const LANG_CARDS: Array<{ key: "en" | "ja" | "ko"; label: string; flag: string; desc: string }> = [
  { key: "en", label: "英语", flag: "🇬🇧", desc: "有学校底子？从这里捡起来" },
  { key: "ja", label: "日语", flag: "🇯🇵", desc: "动漫、旅行、考级都算数" },
  { key: "ko", label: "韩语", flag: "🇰🇷", desc: "追剧、旅行、爱豆应援" },
];

const LEVEL_CARDS: Array<{ key: "zero" | "basic" | "pro"; label: string; desc: string }> = [
  { key: "zero", label: "零基础", desc: "AI 放慢语速、给中文翻译和建议句，照着说就行" },
  { key: "basic", label: "入门", desc: "简单对话 + 中文翻译辅助" },
  { key: "pro", label: "进阶", desc: "自然语速真实对话，无辅助" },
];

export default function Onboarding(): JSX.Element {
  const router = useRouter();
  const { token, user, updateUser } = useAuth();
  const [lang, setLang] = useState<"en" | "ja" | "ko" | undefined>(user?.targetLang ?? "en");
  const [level, setLevel] = useState<"zero" | "basic" | "pro" | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const start = async (): Promise<void> => {
    if (!token || !lang || !level || saving) return;
    setSaving(true);
    try {
      const updated = await api.updateMe(token, { targetLang: lang, level });
      updateUser(updated as PublicUser);
      router.replace("/scenarios");
    } catch (err) {
      Alert.alert("保存失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingTop: 64, gap: 24, paddingBottom: 40 }}>
      <View>
        <Text style={styles.brand}>说嘛</Text>
        <Text style={styles.sub}>两步开始 · 30 秒后你就开口了</Text>
      </View>

      <View>
        <Text style={styles.stepTitle}>① 先选一门想学的课</Text>
        <Text style={styles.stepDesc}>课程可以随时换，先选定一门开始</Text>
        {LANG_CARDS.map((c) => (
          <Pressable
            key={c.key}
            style={[styles.card, lang === c.key && styles.cardOn]}
            onPress={() => setLang(c.key)}
          >
            <Text style={styles.flag}>{c.flag}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, lang === c.key && styles.cardTitleOn]}>{c.label}</Text>
              <Text style={styles.cardDesc}>{c.desc}</Text>
            </View>
            {lang === c.key && <Text style={styles.check}>✓</Text>}
          </Pressable>
        ))}
      </View>

      <View>
        <Text style={styles.stepTitle}>② 你的水平</Text>
        <Text style={styles.stepDesc}>决定 AI 怎么跟你聊——随时可以在「我的」里改</Text>
        {LEVEL_CARDS.map((c) => (
          <Pressable
            key={c.key}
            style={[styles.card, level === c.key && styles.cardOn]}
            onPress={() => setLevel(c.key)}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, level === c.key && styles.cardTitleOn]}>{c.label}</Text>
              <Text style={styles.cardDesc}>{c.desc}</Text>
            </View>
            {level === c.key && <Text style={styles.check}>✓</Text>}
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.cta, (!lang || !level || saving) && styles.ctaOff]}
        disabled={!lang || !level || saving}
        onPress={() => void start()}
      >
        <Text style={styles.ctaText}>{saving ? "保存中…" : "开始学习"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b2239" },
  brand: { fontSize: 40, color: "#f2f7fa", fontWeight: "700", letterSpacing: 6 },
  sub: { color: "#9fb8c9", fontSize: 14, marginTop: 6 },
  stepTitle: { color: "#f2f7fa", fontSize: 18, fontWeight: "700", marginBottom: 4 },
  stepDesc: { color: "#7a92a8", fontSize: 12, marginBottom: 12 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#12314c", borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 2, borderColor: "transparent" },
  cardOn: { borderColor: "#1a73e8", backgroundColor: "#153a5c" },
  flag: { fontSize: 28 },
  cardTitle: { color: "#f2f7fa", fontSize: 16, fontWeight: "600" },
  cardTitleOn: { color: "#9fd1f7" },
  cardDesc: { color: "#7a92a8", fontSize: 12, marginTop: 2, lineHeight: 17 },
  check: { color: "#4da3ff", fontSize: 18, fontWeight: "700" },
  cta: { backgroundColor: "#1a73e8", borderRadius: 14, paddingVertical: 16, alignItems: "center", marginTop: 8 },
  ctaOff: { opacity: 0.4 },
  ctaText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
