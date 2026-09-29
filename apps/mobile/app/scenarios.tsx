import type { JSX } from "react";
/**
 * 情景目录：按目标语言过滤，点情景 → 开聊（30 秒开口）
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, api, type ScenarioSummary } from "../lib/api";
import { useAuth } from "../lib/auth";

const LANGS: Array<{ key: "en" | "ja" | "ko" | "all"; label: string }> = [
  { key: "all", label: "全部" },
  { key: "en", label: "英语" },
  { key: "ja", label: "日语" },
  { key: "ko", label: "韩语" },
];

export default function Scenarios(): JSX.Element {
  const router = useRouter();
  const { token } = useAuth();
  const [lang, setLang] = useState<"en" | "ja" | "ko" | "all">("all");
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api.scenarios(lang === "all" ? undefined : lang)
      .then((res) => { setScenarios(res.scenarios); setError(null); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token, lang]);

  const open = async (scenarioId: string): Promise<void> => {
    if (!token) return;
    setStarting(scenarioId);
    try {
      const started = await api.startConversation(token, scenarioId);
      router.push({ pathname: "/chat/[id]", params: { id: started.sessionId, opener: started.opener, title: started.scenario.title, scenarioId } });
    } catch (err) {
      alertError(err);
    } finally {
      setStarting(null);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.topbar}>
        <Text style={styles.topbarTitle}>选个情景开口</Text>
        <Pressable style={styles.meBtn} onPress={() => router.push("/profile")}>
          <Text style={styles.meBtnText}>我的</Text>
        </Pressable>
      </View>
      <View style={styles.chips}>
        {LANGS.map((l) => (
          <Pressable key={l.key} style={[styles.chip, lang === l.key && styles.chipActive]} onPress={() => setLang(l.key)}>
            <Text style={[styles.chipText, lang === l.key && styles.chipTextActive]}>{l.label}</Text>
          </Pressable>
        ))}
      </View>

      {loading && <ActivityIndicator color="#8fd3ff" style={{ marginTop: 32 }} />}
      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={scenarios}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
        renderItem={({ item }) => (
          <Pressable style={styles.card} disabled={starting !== null} onPress={() => void open(item.id)}>
            <View style={styles.cardTop}>
              <Text style={styles.emoji}>{item.emoji}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.titleEn}>{item.titleEn} · {item.difficulty}</Text>
              </View>
              {starting === item.id
                ? <ActivityIndicator color="#8fd3ff" />
                : <Text style={styles.go}>开聊 →</Text>}
            </View>
            <Text style={styles.setting}>{item.setting}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function alertError(err: unknown): void {
  Alert.alert("开聊失败", err instanceof Error ? err.message : String(err));
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c", padding: 16 },
  topbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  topbarTitle: { color: "#f2f7fa", fontSize: 18, fontWeight: "700" },
  meBtn: { borderRadius: 10, borderWidth: 1, borderColor: "#2a4a66", paddingHorizontal: 14, paddingVertical: 6, backgroundColor: "#0d2233" },
  meBtnText: { color: "#9fd1f7", fontSize: 13 },
  chips: { flexDirection: "row", gap: 8, marginBottom: 12 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: "#12314c" },
  chipActive: { backgroundColor: "#1a73e8" },
  chipText: { color: "#9fb8c9", fontSize: 13 },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  card: { backgroundColor: "#12314c", borderRadius: 14, padding: 14, gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  emoji: { fontSize: 30 },
  title: { color: "#f2f7fa", fontSize: 17, fontWeight: "600" },
  titleEn: { color: "#7d9ab0", fontSize: 12, marginTop: 2 },
  go: { color: "#8fd3ff", fontSize: 14 },
  setting: { color: "#9fb8c9", fontSize: 13, lineHeight: 19 },
  error: { color: "#e08f8f", textAlign: "center", marginTop: 16 },
});
