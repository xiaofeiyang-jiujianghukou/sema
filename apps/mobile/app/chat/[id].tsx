import type { JSX } from "react";
/**
 * 对话屏：文字输入 + 按住说话（语音模式）
 * 计费实时可见；语音走 WS /v1/realtime（AAC 整段上传，服务端转 PCM）
 */
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ApiError, api, type EndResult } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useVoiceMode, type VoiceState } from "../../lib/use-voice-mode";

interface Message {
  role: "user" | "assistant";
  text: string;
  chargedCents?: number;
  balanceCredits?: string;
}

const VOICE_STATE_TEXT: Record<VoiceState, string> = {
  off: "语音未开启",
  connecting: "语音连接中…",
  listening: "按住说话",
  thinking: "教练在想…",
  speaking: "播报中",
};

type LookupResult = {
  word: string;
  translation: string;
  pos: string | null;
  note: string | null;
  fromBook: boolean;
  chargedCents: number;
  balanceCredits: string;
};

/** 助教气泡：单词可点（英/日/韩字母簇），点按即查 */
function TappableText({ text, onWord }: { text: string; onWord: (word: string) => void }) {
  const parts = text.split(/([A-Za-zÀ-ɏ가-힣ぁ-んァ-ヶ一-龥]+)/);
  return (
    <Text style={styles.bubbleText}>
      {parts.map((part, i) =>
        /^[A-Za-zÀ-ɏ가-힣ぁ-んァ-ヶ一-龥]+$/.test(part) ? (
          <Text key={i} style={styles.word} onPress={() => onWord(part)}>
            {part}
          </Text>
        ) : (
          <Text key={i}>{part}</Text>
        ),
      )}
    </Text>
  );
}

export default function Chat(): JSX.Element {
  const router = useRouter();
  const { id, opener, scenarioId } = useLocalSearchParams<{ id: string; opener?: string; scenarioId?: string }>();
  const { token } = useAuth();
  const [messages, setMessages] = useState<Message[]>(opener ? [{ role: "assistant", text: opener }] : []);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{ msgIndex: number; word: string; loading: boolean; result?: LookupResult; saved?: boolean } | null>(null);
  const [translations, setTranslations] = useState<Record<number, { loading: boolean; text?: string; charged?: number; balance?: string }>>({});
  const [pressing, setPressing] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  const handleWordLookup = async (msgIndex: number, word: string, context: string): Promise<void> => {
    if (!token || lookup?.loading) return;
    setLookup({ msgIndex, word, loading: true });
    try {
      const result = (await api.vocabLookup(token, word, context.slice(0, 300), "en")) as LookupResult;
      setLookup({ msgIndex, word, loading: false, result });
    } catch (err) {
      setLookup(null);
      Alert.alert("查词失败", err instanceof Error ? err.message : String(err));
    }
  };

  const handleTranslate = async (msgIndex: number, text: string): Promise<void> => {
    if (!token) return;
    if (translations[msgIndex]) {
      // 再按一次收起
      setTranslations((t) => { const n = { ...t }; delete n[msgIndex]; return n; });
      return;
    }
    setTranslations((t) => ({ ...t, [msgIndex]: { loading: true } }));
    try {
      const result = await api.translateMessage(token, text.slice(0, 500), "en");
      setTranslations((t) => ({ ...t, [msgIndex]: { loading: false, text: result.translation, charged: result.chargedCents, balance: result.balanceCredits } }));
    } catch (err) {
      setTranslations((t) => { const n = { ...t }; delete n[msgIndex]; return n; });
      Alert.alert("翻译失败", err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveVocab = async (): Promise<void> => {
    if (!token || !lookup?.result) return;
    try {
      await api.vocabAdd(token, lookup.result.word, lookup.result.translation);
      setLookup({ ...lookup, saved: true });
      setTimeout(() => setLookup(null), 1500);
    } catch (err) {
      Alert.alert("保存失败", err instanceof Error ? err.message : String(err));
    }
  };

  const voice = useVoiceMode({
    token: token ?? "",
    scenarioId: scenarioId ?? "coffee-order",
    sessionId: id,
    onEvent: (ev) => {
      setMessages((m) => [...m, { role: ev.kind, text: ev.text, chargedCents: ev.chargedCents, balanceCredits: ev.balanceCredits }]);
      if (ev.kind === "assistant") setSessionTotal((t) => t + (ev.chargedCents ?? 0));
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    },
    onError: (message) => {
      if (message.startsWith("没听清")) {
        setVoiceHint(message);
        setTimeout(() => setVoiceHint(null), 3000);
        return;
      }
      Alert.alert("语音提示", message);
    },
  });

  // 语音默认开启：进对话即接通（像打电话，按秒计费，静音也计时；闲置超 5 分钟的空档服务端不计时）
  const voiceAutoStarted = useRef(false);
  useEffect(() => {
    if (!token || voiceAutoStarted.current) return;
    voiceAutoStarted.current = true;
    voice.start();
    setVoiceOn(true);
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [token]);

  // 离开对话即断语音
  useEffect(() => () => voice.stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (voiceOn) {
        voice.stop(); // 关闭 WS；复盘取已有会话，幂等
        setVoiceOn(false);
        router.replace({ pathname: "/review/[id]", params: { id } });
      } else {
        const summary: EndResult = await api.endConversation(token, id);
        Alert.alert("会话已结束", `本次 ${summary.durationSeconds} 秒 · ${summary.turns} 轮 · 合计 ${summary.totalBilledCents} 厘`, [
          { text: "看复盘报告", onPress: () => router.replace({ pathname: "/review/[id]", params: { id } }) },
        ]);
      }
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
        renderItem={({ item, index }) => (
          <Pressable
            style={[styles.bubble, item.role === "user" ? styles.user : styles.assistant]}
            onLongPress={item.role === "assistant" ? () => void handleTranslate(index, item.text) : undefined}
          >
            {item.role === "assistant" ? (
              <>
                <TappableText text={item.text} onWord={(word) => void handleWordLookup(index, word, item.text)} />
                {lookup?.msgIndex === index && (
                  <View style={styles.lookupCard}>
                    {lookup.loading ? (
                      <Text style={styles.lookupText}>查询中…</Text>
                    ) : lookup.result ? (
                      <>
                        <Text style={styles.lookupWord}>
                          {lookup.result.word}
                          {lookup.result.pos ? `  ${lookup.result.pos}` : ""}
                        </Text>
                        <Text style={styles.lookupTranslation}>{lookup.result.translation}</Text>
                        {lookup.result.note ? <Text style={styles.lookupNote}>{lookup.result.note}</Text> : null}
                        <Text style={styles.lookupMeta}>
                          {lookup.saved
                            ? "已存入生词本 ✓"
                            : lookup.result.fromBook
                              ? "已在生词本 · 免费"
                              : `查询 ${lookup.result.chargedCents} 厘 · 余额 ${lookup.result.balanceCredits} 积分`}
                        </Text>
                        {!lookup.saved && (
                          <Pressable style={styles.saveBtn} onPress={() => void handleSaveVocab()}>
                            <Text style={styles.saveBtnText}>存入生词本</Text>
                          </Pressable>
                        )}
                      </>
                    ) : null}
                  </View>
                )}
                {translations[index] && (
                  <View style={styles.lookupCard}>
                    {translations[index].loading ? (
                      <Text style={styles.lookupText}>翻译中…</Text>
                    ) : (
                      <>
                        <Text style={styles.lookupTranslation}>{translations[index].text}</Text>
                        <Text style={styles.lookupMeta}>翻译 {translations[index].charged} 厘 · 余额 {translations[index].balance} 积分 · 再按一次收起</Text>
                      </>
                    )}
                  </View>
                )}
                {item.chargedCents !== undefined && (
                  <Text style={styles.chargeNote}>本轮 {item.chargedCents} 厘 · 余额 {item.balanceCredits} 积分</Text>
                )}
              </>
            ) : (
              <Text style={styles.bubbleText}>{item.text}</Text>
            )}
          </Pressable>
        )}
      />

      <View style={styles.voiceBar}>
        <Pressable
          style={[styles.voiceToggle, voiceOn && styles.voiceOn]}
          onPress={() => {
            if (voiceOn) {
              voice.stop();
              setVoiceOn(false);
            } else {
              voice.start();
              setVoiceOn(true);
            }
          }}
        >
          <Text style={styles.voiceToggleText}>{voiceOn ? "语音中" : "开语音"}</Text>
        </Pressable>
        <Text style={[styles.voiceState, voiceHint && styles.voiceHintText]}>
          {voiceHint ?? (voiceOn ? VOICE_STATE_TEXT[voice.state] : VOICE_STATE_TEXT.off)}
        </Text>
      </View>

      <Pressable
        style={[styles.ptt, pressing && styles.pttPressing]}
        disabled={!voiceOn}
        onPressIn={() => { setPressing(true); void voice.pushToTalkStart(); }}
        onPressOut={() => { setPressing(false); void voice.pushToTalkEnd(); }}
      >
        <Text style={styles.pttText}>{pressing ? "松开发送" : "按住说话"}</Text>
      </Pressable>

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
  word: { color: "#1a73e8", textDecorationLine: "underline" },
  lookupCard: { marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: "#eef4fa" },
  lookupText: { fontSize: 12, color: "#5f7d92" },
  lookupWord: { fontSize: 14, fontWeight: "700", color: "#123" },
  lookupTranslation: { fontSize: 14, color: "#123", marginTop: 2 },
  lookupNote: { fontSize: 11, color: "#5f7d92", marginTop: 4 },
  lookupMeta: { fontSize: 10, color: "#5f7d92", marginTop: 4 },
  saveBtn: { marginTop: 6, alignSelf: "flex-start", backgroundColor: "#1a73e8", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  saveBtnText: { color: "#fff", fontSize: 12 },
  voiceBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingTop: 8 },
  voiceToggle: { backgroundColor: "#12314c", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  voiceOn: { backgroundColor: "#1a73e8" },
  voiceHintText: { color: "#e0b76a" },
  voiceToggleText: { color: "#f2f7fa", fontSize: 14, fontWeight: "600" },
  voiceState: { color: "#7d9ab0", fontSize: 12 },
  ptt: { marginHorizontal: 14, marginTop: 8, paddingVertical: 14, borderRadius: 14, backgroundColor: "#12314c", alignItems: "center" },
  pttPressing: { backgroundColor: "#1a73e8" },
  pttText: { color: "#f2f7fa", fontSize: 16, fontWeight: "600" },
  inputRow: { flexDirection: "row", gap: 8, padding: 12 },
  input: { flex: 1, backgroundColor: "#12314c", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: "#f2f7fa", fontSize: 16, maxHeight: 96 },
  sendBtn: { backgroundColor: "#1a73e8", borderRadius: 12, paddingHorizontal: 18, justifyContent: "center" },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: "#fff", fontWeight: "600" },
  endBtn: { marginHorizontal: 12, marginBottom: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: "#12314c", alignItems: "center" },
  endText: { color: "#f2f7fa", fontSize: 14, fontWeight: "600" },
});
