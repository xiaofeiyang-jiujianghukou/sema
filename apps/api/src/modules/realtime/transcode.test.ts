/**
 * AAC → PCM 转码（真实 ffmpeg）
 * 生成 1s 正弦 AAC → 转码 → 断言 PCM 时长与能量
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { aacToPcm } from "./transcode.js";

const execFileAsync = promisify(execFile);

const hasFfmpeg = await new Promise<boolean>((resolve) => {
  execFileAsync("ffmpeg", ["-version"]).then(() => resolve(true)).catch(() => resolve(false));
});

describe.skipIf(!hasFfmpeg)("AAC → PCM 转码（按住说话）", () => {
  it("1s 正弦 AAC → 16k mono PCM，时长吻合且非静音", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sema-aac-"));
    try {
      const aacPath = join(dir, "sine.aac");
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-ar", "16000", "-ac", "1", "-b:a", "48k",
        aacPath,
      ]);
      const aac = readFileSync(aacPath);
      expect(aac.length).toBeGreaterThan(1000);

      const pcm = await aacToPcm(aac);
      // 16k × s16le × mono = 32000 bytes/s；AAC 编解码有一两百毫秒的 padding 余量
      expect(pcm.length / 32_000).toBeGreaterThan(0.8);
      expect(pcm.length / 32_000).toBeLessThan(1.6);

      // 能量：正弦波 RMS 应远高于静音
      let sum = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        const v = pcm.readInt16LE(i);
        sum += v * v;
      }
      const rms = Math.sqrt(sum / (pcm.length / 2));
      expect(rms).toBeGreaterThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("垃圾输入 → 明确报错", async () => {
    await expect(aacToPcm(Buffer.from("这不是音频")).then(
      () => { throw new Error("不应成功"); },
      (err: Error) => err.message,
    )).resolves.toContain("ffmpeg 转码失败");
  });
});
