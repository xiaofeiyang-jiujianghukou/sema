/**
 * AAC → PCM 转码（移动端按住说话）
 *
 * Expo Go 的 Android 录音只有 AAC 容器（无 PCM/RAW 输出），因此移动端
 * 上行整段 AAC（base64 JSON 帧），服务端用 ffmpeg 转为 16k mono s16le
 * 后送入现有 VAD/barge-in 管线。部署镜像需含 ffmpeg（见 Dockerfile）。
 */
import { spawn } from "node:child_process";

export function aacToPcm(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "s16le",
      "-ar", "16000",
      "-ac", "1",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const out: Buffer[] = [];
    let errText = "";
    ff.stdout.on("data", (chunk: Buffer) => { out.push(chunk); });
    ff.stderr.on("data", (chunk: Buffer) => { errText += chunk.toString("utf8"); });
    ff.on("error", reject);
    ff.stdin.on("error", () => undefined); // ffmpeg 提前退出时的 EPIPE
    ff.on("close", (code) => {
      const pcm = Buffer.concat(out);
      if (code === 0 && pcm.length > 0) {
        resolve(pcm);
      } else {
        reject(new Error(`ffmpeg 转码失败（exit=${code}）: ${errText.slice(0, 300)}`));
      }
    });
    ff.stdin.end(input);
  });
}
