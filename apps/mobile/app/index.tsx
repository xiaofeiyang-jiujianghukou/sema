import type { JSX } from "react";
/**
 * 启动屏：品牌 + API 健康检查 + 登录态分流
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../lib/auth";
import { API_BASE } from "../lib/api";

type Health = { status: "checking" } | { status: "up" } | { status: "down"; message: string };

export default function Index(): JSX.Element {
  const router = useRouter();
  const { user } = useAuth();
  const [health, setHealth] = useState<Health>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/health`)
      .then((res) => res.json() as Promise<{ ok: boolean }>)
      .then((body) => { if (!cancelled) setHealth(body.ok ? { status: "up" } : { status: "down", message: "服务响应异常" }); })
      .catch((err: Error) => { if (!cancelled) setHealth({ status: "down", message: err.message }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (user === undefined) return; // 启动检查中
    const timer = setTimeout(() => {
      router.replace(user ? "/scenarios" : "/login");
    }, health.status === "checking" ? 600 : 0);
    return () => clearTimeout(timer);
  }, [user, health.status, router]);

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.brand}>说嘛</Text>
      <Text style={styles.tagline}>SEMA · 想说就说嘛</Text>
      <Text style={styles.slogan}>用一次，付一次 · 聊到停不下来</Text>
      <View style={styles.healthCard}>
        <Text style={styles.healthTitle}>API（{API_BASE}）· build b11</Text>
        {health.status === "checking" && <ActivityIndicator color="#8fd3ff" />}
        {health.status === "up" && <Text style={styles.healthOk}>● 在线</Text>}
        {health.status === "down" && <Text style={styles.healthDown}>○ 未连接（{health.message}）</Text>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b2239", alignItems: "center", justifyContent: "center", gap: 12 },
  brand: { fontSize: 56, color: "#f2f7fa", fontWeight: "700", letterSpacing: 8 },
  tagline: { fontSize: 16, color: "#9fb8c9", letterSpacing: 2 },
  slogan: { fontSize: 13, color: "#5f7d92", marginTop: 4 },
  healthCard: { marginTop: 40, paddingVertical: 14, paddingHorizontal: 22, borderRadius: 12, backgroundColor: "#12314c", alignItems: "center", gap: 8, minWidth: 280 },
  healthTitle: { fontSize: 12, color: "#7d9ab0" },
  healthOk: { color: "#7ee2a8", fontSize: 14 },
  healthDown: { color: "#e08f8f", fontSize: 13 },
});
