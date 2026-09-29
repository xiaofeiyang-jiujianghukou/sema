/**
 * AGC 自动增益（s16le PCM 16kHz 单声道）：
 * 手机麦克风采音普遍偏低（实测 RMS 865~1442，ASR 友好区间 2000+），
 * 上送识别前放大到目标电平 4000，峰值削波保护（增益上限 ×4）。
 * 近乎静音（RMS<100）不放大，避免抬噪声。
 */
export function rmsOf(pcm: Buffer): number {
  let sumSq = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const v = pcm.readInt16LE(offset);
    sumSq += v * v;
    count += 1;
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

export function applyAgc(pcm: Buffer): Buffer {
  const rms = rmsOf(pcm);
  if (rms < 100) return pcm;
  const gain = Math.min(4, Math.max(1, 4000 / rms));
  if (gain <= 1.05) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain)));
    out.writeInt16LE(v, i);
  }
  return out;
}
