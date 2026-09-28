/**
 * 语音脚本共享环境读取：仓库根 .env → ARK API Key
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface VoiceEnv {
  apiKey: string;
  speaker?: string;
}

export function loadEnv(): VoiceEnv {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  let apiKey = process.env.SEMA_LLM_API_KEY ?? process.env.ARK_API_KEY ?? "";
  let speaker = process.env.SEMA_TTS_SPEAKER;
  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key === "SEMA_LLM_API_KEY" && value.length > 0) apiKey = value;
      if (key === "SEMA_TTS_SPEAKER" && value.length > 0) speaker = value;
    }
  } catch {
    // .env 可选
  }
  if (apiKey.length === 0) {
    throw new Error("缺少 API Key：请在 sema/.env 的 SEMA_LLM_API_KEY 填入方舟 Key");
  }
  return { apiKey, speaker };
}
