import type { JSX } from "react";
/**
 * 复盘报告：纠错 / 地道说法 / 生词 / 亮点与重点
 * 进屏先查已有报告（幂等），没有则生成（1 积分）
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ApiError, api, type ReviewReport } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export default function Review(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token } = useAuth();
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !id) return;
    void (async () => {
      try {
        // 已有报告直接取；否则生成（服务端幂等，重复生成不重复扣费）
        const got = await api.getReview(token, id).catch((err: ApiError) => {
          if (err.status === 404) return api.review(token, id);
          throw err;
        });
        setReport(got);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [token, id]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#8fd3ff" />
        <Text style={styles.loadingText}>教练正在回看你的对话…</Text>
      </View>
    );
  }
  if (error || !report) {
    return <View style={styles.center}><Text style={styles.error}>{error ?? "报告不存在"}</Text></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      <View style={styles.levelCard}>
        <Text style={styles.levelLabel}>本轮水平评估</Text>
        <Text style={styles.level}>{report.overall.level}</Text>
      </View>

      <Section title={`纠错（${report.corrections.length}）`} empty="这轮没有明显错误，继续保持！">
        {report.corrections.map((c, i) => (
          <View key={i} style={styles.card}>
            <Text style={styles.bad}>✗ {c.original}</Text>
            <Text style={styles.good}>✓ {c.corrected}</Text>
            <Text style={styles.note}>{c.explanation}</Text>
          </View>
        ))}
      </Section>

      <Section title={`更地道的说法（${report.alternatives.length}）`} empty="—">
        {report.alternatives.map((a, i) => (
          <View key={i} style={styles.card}>
            <Text style={styles.plain}>{a.original}</Text>
            <Text style={styles.good}>→ {a.suggestion}</Text>
            <Text style={styles.note}>{a.note}</Text>
          </View>
        ))}
      </Section>

      <Section title={`生词（${report.vocab.length}）`} empty="—">
        {report.vocab.map((v, i) => (
          <View key={i} style={styles.card}>
            <Text style={styles.term}>{v.term}</Text>
            <Text style={styles.plain}>{v.translation}</Text>
            <Text style={styles.note}>已自动加入生词本，隔天就能复习</Text>
          </View>
        ))}
      </Section>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>教练点评</Text>
        <Text style={styles.plain}>亮点：{report.overall.strengths}</Text>
        <Text style={styles.plain}>重点：{report.overall.focus}</Text>
      </View>

      <Text style={styles.foot}>本次复盘 {report.priceCents / 100} 积分 · 一次会话一份，反复查看不再计费</Text>
    </ScrollView>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }): JSX.Element {
  const has = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <View>
      <Text style={styles.sectionTitle}>{title}</Text>
      {has ? <View style={{ gap: 8, marginTop: 8 }}>{children}</View> : <Text style={styles.note}>{empty}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c" },
  center: { flex: 1, backgroundColor: "#081a2c", alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: "#7d9ab0", fontSize: 14 },
  levelCard: { backgroundColor: "#1a73e8", borderRadius: 14, padding: 16, alignItems: "center" },
  levelLabel: { color: "#cfe3f5", fontSize: 13 },
  level: { color: "#fff", fontSize: 28, fontWeight: "700", marginTop: 4 },
  sectionTitle: { color: "#8fd3ff", fontSize: 16, fontWeight: "600" },
  card: { backgroundColor: "#12314c", borderRadius: 12, padding: 12, gap: 4 },
  bad: { color: "#e08f8f", fontSize: 15 },
  good: { color: "#7ee2a8", fontSize: 15 },
  plain: { color: "#f2f7fa", fontSize: 15, lineHeight: 22 },
  note: { color: "#7d9ab0", fontSize: 13, lineHeight: 19 },
  term: { color: "#8fd3ff", fontSize: 16, fontWeight: "600" },
  foot: { color: "#5f7d92", fontSize: 12, textAlign: "center" },
  error: { color: "#e08f8f" },
});
