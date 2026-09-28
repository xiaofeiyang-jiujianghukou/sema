import type { JSX } from "react";
/**
 * 对话屏（文字版 M3）：消息流 + 按秒计费实时可见 + 结束出复盘
 * 语音（WS 实时流）在后续版本接入——先让学习闭环跑通
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ApiError, api, type EndResult } from "../../lib/api";
import { useAuth } from "../../lib/auth";

interface Message {
  role: "user" | "assistant";
  text: string;
  chargedCents?: number;
  balanceCredits?: string;
}

export default function Chat(): JSX.Element {
  const router = useRouter();
  const { id, opener } = useLocalSearchParams<{ id: string; opener?: string }>();
  const { token } = useAuth();
  const [messages, setMessages] = useState<Message[]>(opener ? [{ role: "assistant", text: opener }] : []);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [sessionTotal, setSessionTotal] = useState(0);
  const listRef = useRef<FlatList<Message>>(null);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || !token || sending) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setSending(true);
    try {
      const turn = await api.turn(token, id, text);
      setMessages((m) => [...m, { role: "assistant", text: turn.reply, chargedCents: turn.chargedCents, balanceCredits: turn.balanceCredits }]);
      setSessionTotal((t) => t + turn.chargedCents);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_FUNDS") {
        Alert.alert("余额不足", "对话已暂停。去「我的」看看余额，充值后继续。");
      } else {
        Alert.alert("发送失败", err instanceof ApiError ? err.message : String(err));
      }
      setMessages((m) => m.filter((x, i) => !(i === m.length - 1 && x.role === "user")));
      setInput(text);
    } finally {
      setSending(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    }
  };

  const endAndReview = async (): Promise<void> => {
    if (!token || ending) return;
    setEnding(true);
    try {
      const summary: EndResult = await api.endConversation(token, id);
      Alert.alert("会话已结束", `本次 ${summary.durationSeconds} 秒 · ${summary.turns} 轮 · 合计 ${summary.totalBilledCents} 厘`, [
        { text: "看复盘报告", onPress: () => router.replace({ pathname: "/review/[id]", params: { id } }) },
      ]);
    } catch (err) {
      Alert.alert("结束失败", err instanceof ApiError ? err.message : String(err));
      setEnding(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "android" ? undefined : "padding"}>
      <View style={styles.meterBar}>
        <Text style={styles.meterText}>本次已计 {sessionTotal} 厘 · 5厘/秒 按秒累进</Text>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 14, gap: 10 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === "user" ? styles.user : styles.assistant]}>
            <Text style={styles.bubbleText}>{item.text}</Text>
            {item.role === "assistant" && item.chargedCents !== undefined && (
              <Text style={styles.chargeNote}>本轮 {item.chargedCents} 厘 · 余额 {item.balanceCredits} 积分</Text>
            )}
          </View>
        )}
      />

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="用目标语言说点什么…"
          placeholderTextColor="#5f7d92"
          multiline
          value={input}
          onChangeText={setInput}
        />
        <Pressable style={[styles.sendBtn, (sending || !input.trim()) && styles.sendDisabled]} disabled={sending || !input.trim()} onPress={() => void send()}>
          {sending ? <ActivityIndicator size="small" color="#0b2239" /> : <Text style={styles.sendText}>发送</Text>}
        </Pressable>
      </View>

      <Pressable style={styles.endBtn} disabled={ending} onPress={() => void endAndReview()}>
        {ending ? <ActivityIndicator size="small" color="#f2f7fa" /> : <Text style={styles.endText}>结束并生成复盘（1 积分）</Text>}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c" },
  meterBar: { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: "#0e2740" },
  meterText: { color: "#7d9ab0", fontSize: 12 },
  bubble: { maxWidth: "85%", borderRadius: 14, padding: 12 },
  user: { alignSelf: "flex-end", backgroundColor: "#1a73e8" },
  assistant: { alignSelf: "flex-start", backgroundColor: "#12314c" },
  bubbleText: { color: "#f2f7fa", fontSize: 16, lineHeight: 23 },
  chargeNote: { color: "#5f7d92", fontSize: 10, marginTop: 6 },
  inputRow: { flexDirection: "row", gap: 8, padding: 12 },
  input: { flex: 1, backgroundColor: "#12314c", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: "#f2f7fa", fontSize: 16, maxHeight: 96 },
  sendBtn: { backgroundColor: "#1a73e8", borderRadius: 12, paddingHorizontal: 18, justifyContent: "center" },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: "#fff", fontWeight: "600" },
  endBtn: { marginHorizontal: 12, marginBottom: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: "#12314c", alignItems: "center" },
  endText: { color: "#f2f7fa", fontSize: 14, fontWeight: "600" },
});
