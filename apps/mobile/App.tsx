import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, View } from "react-native";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8787";

type HealthState =
  | { status: "checking" }
  | { status: "up"; time: string }
  | { status: "down"; message: string };

/**
 * 言泉 · 品牌启动屏（M0 占位）
 * M1 将替换为「30 秒内开口」的情景对话首页。
 */
export default function App() {
  const [health, setHealth] = useState<HealthState>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/health`)
      .then((res) => res.json() as Promise<{ ok: boolean; time: string }>)
      .then((body) => {
        if (!cancelled && body.ok) setHealth({ status: "up", time: body.time });
        else if (!cancelled) setHealth({ status: "down", message: "服务响应异常" });
      })
      .catch((err: Error) => {
        if (!cancelled) setHealth({ status: "down", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.brand}>言泉</Text>
      <Text style={styles.tagline}>言泉流于唇齿</Text>
      <Text style={styles.slogan}>用一次，付一次 · 说到滔滔不绝</Text>

      <View style={styles.healthCard}>
        <Text style={styles.healthTitle}>API 状态（{API_URL}）</Text>
        {health.status === "checking" && <ActivityIndicator color="#8fd3ff" />}
        {health.status === "up" && <Text style={styles.healthOk}>● 在线 {health.time}</Text>}
        {health.status === "down" && (
          <Text style={styles.healthDown}>○ 未连接（{health.message}）</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b2239",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  brand: { fontSize: 56, color: "#f2f7fa", fontWeight: "700", letterSpacing: 8 },
  tagline: { fontSize: 16, color: "#9fb8c9", letterSpacing: 2 },
  slogan: { fontSize: 13, color: "#5f7d92", marginTop: 4 },
  healthCard: {
    marginTop: 40,
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    backgroundColor: "#12314c",
    alignItems: "center",
    gap: 8,
    minWidth: 280,
  },
  healthTitle: { fontSize: 12, color: "#7d9ab0" },
  healthOk: { color: "#7ee2a8", fontSize: 14 },
  healthDown: { color: "#e08f8f", fontSize: 14 },
});
