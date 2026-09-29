import type { JSX } from "react";
/**
 * 说嘛 · 移动端根布局（expo-router）
 * 深色品牌底色 + 认证状态包裹全局
 */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "../lib/auth";

export default function RootLayout(): JSX.Element {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#0b2239" },
          headerTintColor: "#f2f7fa",
          contentStyle: { backgroundColor: "#081a2c" },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ title: "登录 / 注册", headerShown: true }} />
        <Stack.Screen name="onboarding" options={{ title: "开始学习", headerShown: false }} />
        <Stack.Screen name="course" options={{ title: "我的课程", headerShown: false }} />
        <Stack.Screen name="challenge/[id]" options={{ title: "闯关", headerShown: true }} />
        <Stack.Screen name="scenarios" options={{ title: "选个情景开口", headerShown: true }} />
        <Stack.Screen name="chat/[id]" options={{ headerShown: true, title: "对话中" }} />
        <Stack.Screen name="review/[id]" options={{ title: "复盘报告", headerShown: true }} />
        <Stack.Screen name="vocab" options={{ title: "生词本", headerShown: true }} />
        <Stack.Screen name="profile" options={{ title: "我的", headerShown: true }} />
      </Stack>
    </AuthProvider>
  );
}
