import type { JSX } from "react";
/**
 * 生词本：到期复习（FSRS 打分 1-4）+ 全部卡片 + 手动添加 + AI 精讲（10厘/词）
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError, api, type VocabCard, type VocabLecture } from "../lib/api";
import { useAuth } from "../lib/auth";

const GRADES: Array<{ g: 1 | 2 | 3 | 4; label: string; hint: string; color: string }> = [
  { g: 1, label: "忘了", hint: "尽快再见", color: "#e08f8f" },
  { g: 2, label: "费劲", hint: "缩短间隔", color: "#e0b48f" },
  { g: 3, label: "顺利", hint: "正常推进", color: "#7ee2a8" },
  { g: 4, label: "轻松", hint: "拉长间隔", color: "#8fd3ff" },
];

export default function Vocab(): JSX.Element {
  const { token } = useAuth();
  const [due, setDue] = useState<VocabCard[]>([]);
  const [all, setAll] = useState<VocabCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [grading, setGrading] = useState<string | null>(null);
  const [addTerm, setAddTerm] = useState("");
  const [addTranslation, setAddTranslation] = useState("");
  const [lecture, setLecture] = useState<{ term: string; lecture: VocabLecture; cached: boolean; chargedCents: number } | null>(null);
  const [lectureBusy, setLectureBusy] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) return;
    const [d, a] = await Promise.all([api.vocabDue(token), api.vocabList(token)]);
    setDue(d.cards);
    setAll(a.cards);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void refresh().catch((err: Error) => Alert.alert("加载失败", err.message)).finally(() => setLoading(false));
  }, [token, refresh]);

  const grade = async (cardId: string, g: 1 | 2 | 3 | 4): Promise<void> => {
    if (!token) return;
    setGrading(cardId);
    try {
      await api.vocabGrade(token, cardId, g);
      await refresh();
    } catch (err) {
      Alert.alert("打分失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setGrading(null);
    }
  };

  const showLecture = async (cardId: string): Promise<void> => {
    if (!token) return;
    setLectureBusy(cardId);
    try {
      const res = await api.lecture(token, cardId);
      setLecture(res);
      await refresh();
    } catch (err) {
      Alert.alert("精讲失败", err instanceof ApiError ? err.message : String(err));
    } finally {
      setLectureBusy(null);
    }
  };

  const add = async (): Promise<void> => {
    if (!token || !addTerm.trim() || !addTranslation.trim()) return;
    try {
      const res = await api.vocabAdd(token, addTerm.trim(), addTranslation.trim());
      Alert.alert(res.created ? "已加入生词本" : "这个词已经在生词本里啦");
      setAddTerm("");
      setAddTranslation("");
      await refresh();
    } catch (err) {
      Alert.alert("添加失败", err instanceof ApiError ? err.message : String(err));
    }
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color="#8fd3ff" /></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.addRow}>
        <TextInput style={[styles.input, styles.termInput]} placeholder="生词" placeholderTextColor="#5f7d92" value={addTerm} onChangeText={setAddTerm} />
        <TextInput style={[styles.input, styles.termInput]} placeholder="释义" placeholderTextColor="#5f7d92" value={addTranslation} onChangeText={setAddTranslation} />
        <Pressable style={styles.addBtn} onPress={() => void add()}><Text style={styles.addBtnText}>＋</Text></Pressable>
      </View>

      <Text style={styles.section}>今天要复习（{due.length}）</Text>
      <FlatList
        data={due}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
        renderItem={({ item }) => (
          <Card card={item} due grading={grading === item.id} lectureBusy={lectureBusy === item.id} onGrade={(g) => void grade(item.id, g)} onLecture={() => void showLecture(item.id)} />
        )}
      />

      <Text style={styles.section}>全部生词（{all.length}）</Text>
      <FlatList
        style={{ flex: 1 }}
        data={all}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ gap: 8, paddingBottom: 20 }}
        renderItem={({ item }) => (
          <Card card={item} grading={false} lectureBusy={lectureBusy === item.id} onLecture={() => void showLecture(item.id)} />
        )}
      />

      <Modal visible={lecture !== null} transparent animationType="slide" onRequestClose={() => setLecture(null)}>
        {lecture && (
          <View style={styles.modalMask}>
            <View style={styles.modal}>
              <Text style={styles.lectureTerm}>{lecture.term}</Text>
              <Text style={styles.lectureCharge}>{lecture.cached ? "已缓存，免费" : `本次生成 ${lecture.chargedCents} 厘（每词只讲一次）`}</Text>
              <ScrollView style={{ maxHeight: 420 }}>
                <Text style={styles.lectureDef}>{lecture.lecture.definition}</Text>
                {lecture.lecture.examples.map((e, i) => (
                  <View key={i} style={{ marginTop: 8 }}>
                    <Text style={styles.plain}>{e.text}</Text>
                    <Text style={styles.note}>{e.zh}</Text>
                  </View>
                ))}
                <Text style={styles.lectureBlock}>辨析：{lecture.lecture.nuance}</Text>
                <Text style={styles.lectureBlock}>记忆钩子：{lecture.lecture.memoryHook}</Text>
                <Text style={styles.lectureBlock}>搭配：{lecture.lecture.collocations.join(" · ")}</Text>
              </ScrollView>
              <Pressable style={styles.closeBtn} onPress={() => setLecture(null)}>
                <Text style={styles.closeText}>知道了</Text>
              </Pressable>
            </View>
          </View>
        )}
      </Modal>
    </View>
  );
}

function Card({ card, due: isDue, grading, lectureBusy, onGrade, onLecture }: {
  card: VocabCard;
  due?: boolean;
  grading: boolean;
  lectureBusy: boolean;
  onGrade?: (g: 1 | 2 | 3 | 4) => void;
  onLecture: () => void;
}): JSX.Element {
  const dueDate = new Date(card.dueMs);
  const dueText = card.dueMs <= Date.now() ? "现在" : `${dueDate.getMonth() + 1}/${dueDate.getDate()}`;
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.term}>{card.term}</Text>
          <Text style={styles.plain}>{card.translation}</Text>
          <Text style={styles.note}>{isDue ? "到点啦" : `下次复习 ${dueText}`} · 已复习 {card.reviewCount} 次</Text>
        </View>
        <Pressable style={styles.lectureBtn} disabled={lectureBusy} onPress={onLecture}>
          {lectureBusy ? <ActivityIndicator size="small" color="#0b2239" /> : <Text style={styles.lectureBtnText}>精讲</Text>}
        </Pressable>
      </View>
      {isDue && onGrade && (
        <View style={styles.gradeRow}>
          {GRADES.map((g) => (
            <Pressable key={g.g} style={[styles.gradeBtn, { borderColor: g.color }]} disabled={grading} onPress={() => onGrade(g.g)}>
              <Text style={[styles.gradeLabel, { color: g.color }]}>{g.label}</Text>
              <Text style={styles.gradeHint}>{g.hint}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#081a2c", padding: 14, gap: 8 },
  center: { flex: 1, backgroundColor: "#081a2c", justifyContent: "center" },
  addRow: { flexDirection: "row", gap: 6 },
  input: { backgroundColor: "#12314c", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, color: "#f2f7fa", fontSize: 14 },
  termInput: { flex: 1 },
  addBtn: { backgroundColor: "#1a73e8", borderRadius: 10, width: 42, alignItems: "center", justifyContent: "center" },
  addBtnText: { color: "#fff", fontSize: 22, fontWeight: "600" },
  section: { color: "#8fd3ff", fontSize: 15, fontWeight: "600", marginTop: 6 },
  card: { backgroundColor: "#12314c", borderRadius: 12, padding: 12, gap: 8 },
  cardHead: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  term: { color: "#8fd3ff", fontSize: 17, fontWeight: "600" },
  plain: { color: "#f2f7fa", fontSize: 14, lineHeight: 21 },
  note: { color: "#5f7d92", fontSize: 12, marginTop: 2 },
  lectureBtn: { backgroundColor: "#8fd3ff", borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7 },
  lectureBtnText: { color: "#0b2239", fontWeight: "600", fontSize: 13 },
  gradeRow: { flexDirection: "row", gap: 6 },
  gradeBtn: { flex: 1, borderWidth: 1.5, borderRadius: 10, paddingVertical: 7, alignItems: "center" },
  gradeLabel: { fontSize: 14, fontWeight: "600" },
  gradeHint: { color: "#5f7d92", fontSize: 10, marginTop: 1 },
  modalMask: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modal: { backgroundColor: "#0e2740", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, gap: 6 },
  lectureTerm: { color: "#fff", fontSize: 22, fontWeight: "700" },
  lectureCharge: { color: "#5f7d92", fontSize: 12 },
  lectureDef: { color: "#f2f7fa", fontSize: 15, lineHeight: 22, marginTop: 6 },
  lectureBlock: { color: "#cfe3f5", fontSize: 14, lineHeight: 21, marginTop: 10 },
  closeBtn: { backgroundColor: "#1a73e8", borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 12 },
  closeText: { color: "#fff", fontWeight: "600" },
});
