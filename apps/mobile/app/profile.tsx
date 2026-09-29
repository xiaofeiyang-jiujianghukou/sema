import type { JSX } from "react";
/**
 * 我的：档案统计 + 钱包流水 + 登出 + 充值占位（微信支付商户号申请中）
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, api, auth, type LearningProfile, type UserLevels, type WalletInfo } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Profile(): JSX.Element {
  const router = useRouter();
  const { token, user, logout, updateUser } = useAuth();
  const [stats, setStats] = useState<LearningProfile | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [levels, setLevels] = useState<UserLevels>(user?.levels ?? {});

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) return;
    const [s, w] = await Promise.all([api.stats(token), api.wallet(token)]);
    setStats(s);
    setWallet(w);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void refresh().catch((err: Error) => Alert.alert("加载失败", err.message)).finally(() => setLoading(false));
  }, [token, refresh]);

  const maxSeconds = Math.max(1, ...(stats?.activity.map((a) => a.seconds) ?? [1]));

  if (loading || !stats || !wallet || !user) {
    return <View style={styles.center}><ActivityIndicator color="#8fd3ff" /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      <View style={styles.userCard}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{user.nickname.slice(0, 1)}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.nickname}>{user.nickname}</Text>
          <Text style={styles.phone}>{user.phone}</Text>
        </View>
        <Pressable onPress={() => void logout().then(() => router.replace("/login"))}>
          <Text style={styles.logout}>退出登录</Text>
        </Pressable>
        <Pressable onPress={() => Alert.alert("注销账号", "将删除你的全部对话、复盘、生词与钱包数据，且不可恢复。确定注销吗？", [
          { text: "取消", style: "cancel" },
          {
            text: "确认注销",
            style: "destructive",
            onPress: () => {
              if (!token) return;
              void auth.deleteAccount(token)
                .then(() => logout().then(() => router.replace("/login")))
                .catch((err: unknown) => Alert.alert("注销失败", err instanceof ApiError ? err.message : String(err)));
            },
          },
        ])}>
          <Text style={styles.danger}>注销账号</Text>
        </Pressable>
      </View>

      <View style={styles.levelCard}>
        <Text style={styles.levelTitle}>各科水平</Text>
        <Text style={styles.levelDesc}>每门课单独定级——英语进阶不妨碍日语零基础。改某门课的水平会同时把它设为当前课程。零基础：AI 放慢+翻译+建议句；入门：翻译；进阶：无辅助</Text>
        {([["en", "英语"], ["ja", "日语"], ["ko", "韩语"]] as const).map(([lang, label]) => (
          <View key={lang} style={styles.levelLangRow}>
            <Text style={styles.levelLang}>{label}</Text>
            <View style={styles.levelRow}>
              {([["zero", "零基础"], ["basic", "入门"], ["pro", "进阶"]] as const).map(([value, lvLabel]) => (
                <Pressable
                  key={value}
                  style={[styles.levelBtn, levels[lang] === value && styles.levelBtnOn]}
                  onPress={() => {
                    setLevels((prev) => ({ ...prev, [lang]: value }));
                    if (token) {
                      void api.updateMe(token, { targetLang: lang, level: value })
                        .then((u) => updateUser(u))
                        .catch((err: unknown) => {
                          Alert.alert("保存失败", err instanceof ApiError ? err.message : String(err));
                        });
                    }
                  }}
                >
                  <Text style={[styles.levelBtnText, levels[lang] === value && styles.levelBtnTextOn]}>{lvLabel}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </View>

      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>积分余额</Text>
        <Text style={styles.balance}>{wallet.balanceCredits}<Text style={styles.balanceUnit}> 积分</Text></Text>
        <Pressable style={styles.topupBtn} onPress={() => Alert.alert("充值通道即将开放", "微信支付商户号资质申请中——开放后会第一时间通知你。")}>
          <Text style={styles.topupText}>充值（微信支付 · 开通中）</Text>
        </Pressable>
      </View>

      <View style={styles.statGrid}>
        <Stat label="连续学习" value={`${stats.streakDays} 天`} />
        <Stat label="开口次数" value={String(stats.turns)} />
        <Stat label="总时长" value={`${Math.floor(stats.totalSeconds / 60)} 分 ${stats.totalSeconds % 60} 秒`} />
        <Stat label="累计消费" value={`${(stats.totalBilledCents / 100).toFixed(2)} 积分`} />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>词汇成长</Text>
        <Text style={styles.plain}>生词 {stats.vocab.total} 个 · 7 天新增 {stats.vocab.addedLast7Days} 个 · 今日到期 {stats.vocab.dueNow} 个 · 累计复习 {stats.vocab.reviewsDone} 次</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>近 14 天开口时长</Text>
        <View style={styles.bars}>
          {stats.activity.map((a) => (
            <View key={a.date} style={styles.barCol}>
              <View style={[styles.bar, { height: Math.max(2, (a.seconds / maxSeconds) * 64) }]} />
              <Text style={styles.barLabel}>{a.date.slice(8)}</Text>
            </View>
          ))}
        </View>
      </View>

      <Text style={styles.foot}>数据随时可导出（设置 → 导出我的数据）· 你的对话属于你</Text>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c" },
  center: { flex: 1, backgroundColor: "#081a2c", justifyContent: "center" },
  userCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#12314c", borderRadius: 14, padding: 14 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: "#1a73e8", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#fff", fontSize: 22, fontWeight: "700" },
  nickname: { color: "#f2f7fa", fontSize: 17, fontWeight: "600" },
  phone: { color: "#7d9ab0", fontSize: 13, marginTop: 2 },
  logout: { color: "#e08f8f", fontSize: 14 },
  danger: { color: "#e08f8f", fontSize: 12, marginTop: 6 },
  levelCard: { backgroundColor: "#132a3d", borderRadius: 14, padding: 14, gap: 8 },
  levelTitle: { color: "#f2f7fa", fontSize: 14, fontWeight: "600" },
  levelDesc: { color: "#7a92a8", fontSize: 11, lineHeight: 16 },
  levelLangRow: { gap: 4 },
  levelLang: { color: "#9fb8c9", fontSize: 12 },
  levelRow: { flexDirection: "row", gap: 8 },
  levelBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: "center", backgroundColor: "#0d2233", borderWidth: 1, borderColor: "#1f3d55" },
  levelBtnOn: { backgroundColor: "#1a73e8", borderColor: "#1a73e8" },
  levelBtnText: { color: "#7a92a8", fontSize: 13 },
  levelBtnTextOn: { color: "#fff", fontWeight: "600" },
  balanceCard: { backgroundColor: "#0e2740", borderRadius: 14, padding: 16, gap: 6 },
  balanceLabel: { color: "#7d9ab0", fontSize: 13 },
  balance: { color: "#7ee2a8", fontSize: 34, fontWeight: "700" },
  balanceUnit: { fontSize: 14, fontWeight: "400", color: "#7d9ab0" },
  topupBtn: { backgroundColor: "#1a73e8", borderRadius: 10, paddingVertical: 10, alignItems: "center", marginTop: 4 },
  topupText: { color: "#fff", fontWeight: "600" },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statCell: { backgroundColor: "#12314c", borderRadius: 12, padding: 12, minWidth: "48%", flexGrow: 1 },
  statValue: { color: "#8fd3ff", fontSize: 18, fontWeight: "700" },
  statLabel: { color: "#7d9ab0", fontSize: 12, marginTop: 2 },
  card: { backgroundColor: "#12314c", borderRadius: 12, padding: 14, gap: 6 },
  sectionTitle: { color: "#8fd3ff", fontSize: 15, fontWeight: "600" },
  plain: { color: "#f2f7fa", fontSize: 14, lineHeight: 21 },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 4, marginTop: 6 },
  barCol: { flex: 1, alignItems: "center", gap: 4 },
  bar: { width: "70%", backgroundColor: "#1a73e8", borderRadius: 3 },
  barLabel: { color: "#5f7d92", fontSize: 9 },
  foot: { color: "#5f7d92", fontSize: 12, textAlign: "center" },
});
