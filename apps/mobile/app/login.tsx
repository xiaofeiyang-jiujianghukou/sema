import type { JSX } from "react";
/**
 * 登录 / 注册：手机号 + 密码 或 手机号 + 验证码
 * 注册 = 手机号 + 验证码 + 设密码（8-64 位）
 */
import { useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, auth } from "../lib/api";
import { useAuth } from "../lib/auth";

type Mode = "login" | "register";
type LoginWay = "password" | "code";

export default function Login(): JSX.Element {
  const router = useRouter();
  const { loginPassword, loginCode, register } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [way, setWay] = useState<LoginWay>("password");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const tick = (): void => {
    setCountdown((c) => {
      if (c <= 1) return 0;
      setTimeout(tick, 1000);
      return c - 1;
    });
  };

  const sendCode = async (purpose: "register" | "login"): Promise<void> => {
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      Alert.alert("手机号格式不正确");
      return;
    }
    setSending(true);
    try {
      await auth.requestCode(phone, purpose);
      setCountdown(60);
      setTimeout(tick, 1000);
      Alert.alert("验证码已发送", purpose === "register" ? "请查看短信（5 分钟内有效）" : "请查看短信");
    } catch (err) {
      Alert.alert("发送失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      if (mode === "register") {
        await register(phone, code, password, nickname || undefined);
      } else if (way === "password") {
        await loginPassword(phone, password);
      } else {
        await loginCode(phone, code);
      }
      router.replace("/scenarios");
    } catch (err) {
      Alert.alert("失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "android" ? undefined : "padding"}>
      <View style={styles.tabs}>
        <Pressable style={[styles.tab, mode === "login" && styles.tabActive]} onPress={() => setMode("login")}>
          <Text style={[styles.tabText, mode === "login" && styles.tabTextActive]}>登录</Text>
        </Pressable>
        <Pressable style={[styles.tab, mode === "register" && styles.tabActive]} onPress={() => setMode("register")}>
          <Text style={[styles.tabText, mode === "register" && styles.tabTextActive]}>注册</Text>
        </Pressable>
      </View>

      <TextInput
        style={styles.input}
        placeholder="手机号"
        placeholderTextColor="#5f7d92"
        keyboardType="phone-pad"
        maxLength={11}
        value={phone}
        onChangeText={setPhone}
      />

      {mode === "login" && (
        <View style={styles.wayTabs}>
          <Pressable onPress={() => setWay("password")}>
            <Text style={[styles.wayText, way === "password" && styles.wayActive]}>密码登录</Text>
          </Pressable>
          <Pressable onPress={() => setWay("code")}>
            <Text style={[styles.wayText, way === "code" && styles.wayActive]}>验证码登录</Text>
          </Pressable>
        </View>
      )}

      {mode === "login" && way === "password" && (
        <TextInput style={styles.input} placeholder="密码" placeholderTextColor="#5f7d92" secureTextEntry value={password} onChangeText={setPassword} />
      )}

      {(mode === "register" || (mode === "login" && way === "code")) && (
        <View style={styles.codeRow}>
          <TextInput style={[styles.input, styles.codeInput]} placeholder="6 位验证码" placeholderTextColor="#5f7d92" keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} />
          <Pressable style={[styles.codeBtn, countdown > 0 && styles.codeBtnDisabled]} disabled={countdown > 0 || sending} onPress={() => void sendCode(mode === "register" ? "register" : "login")}>
            {sending
              ? <ActivityIndicator size="small" color="#0b2239" />
              : <Text style={styles.codeBtnText}>{countdown > 0 ? `${countdown}s` : "发验证码"}</Text>}
          </Pressable>
        </View>
      )}

      {mode === "register" && (
        <>
          <TextInput style={styles.input} placeholder="密码（8-64 位）" placeholderTextColor="#5f7d92" secureTextEntry value={password} onChangeText={setPassword} />
          <TextInput style={styles.input} placeholder="昵称（可选）" placeholderTextColor="#5f7d92" maxLength={24} value={nickname} onChangeText={setNickname} />
        </>
      )}

      <Pressable style={[styles.submit, busy && styles.submitBusy]} disabled={busy} onPress={() => void submit()}>
        {busy ? <ActivityIndicator color="#0b2239" /> : <Text style={styles.submitText}>{mode === "login" ? "登录" : "注册并登录"}</Text>}
      </Pressable>

      <Text style={styles.hint}>用一次付一次 · 新用户注册后自动到账体验金</Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c", padding: 24, justifyContent: "center", gap: 14 },
  tabs: { flexDirection: "row", gap: 8, marginBottom: 8 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: "#12314c", alignItems: "center" },
  tabActive: { backgroundColor: "#1a73e8" },
  tabText: { color: "#9fb8c9", fontSize: 16 },
  tabTextActive: { color: "#fff", fontWeight: "600" },
  wayTabs: { flexDirection: "row", gap: 16 },
  wayText: { color: "#5f7d92", fontSize: 14 },
  wayActive: { color: "#8fd3ff", fontWeight: "600" },
  input: { backgroundColor: "#12314c", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, color: "#f2f7fa", fontSize: 16 },
  codeRow: { flexDirection: "row", gap: 8 },
  codeInput: { flex: 1 },
  codeBtn: { backgroundColor: "#8fd3ff", borderRadius: 10, paddingHorizontal: 14, justifyContent: "center", minWidth: 92, alignItems: "center" },
  codeBtnDisabled: { backgroundColor: "#37536b" },
  codeBtnText: { color: "#0b2239", fontWeight: "600" },
  submit: { backgroundColor: "#1a73e8", borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  submitBusy: { opacity: 0.7 },
  submitText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  hint: { color: "#5f7d92", fontSize: 12, textAlign: "center" },
});
