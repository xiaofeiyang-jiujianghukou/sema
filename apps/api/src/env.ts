/**
 * 零依赖 .env 加载器
 *
 * 约定（12-factor）：
 * - 真实环境变量 > .env 文件（进程环境里已有的值绝不被覆盖）
 * - 候选路径：仓库根 sema/.env（相对本文件定位）> 进程 cwd/.env
 * - 只接受 KEY=VALUE 行；# 注释与空行忽略；值可带引号
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}

export function loadEnvFiles(): string[] {
  const candidates = [
    fileURLToPath(new URL("../../../.env", import.meta.url)),
    `${process.cwd()}/.env`,
  ];
  const loaded: string[] = [];
  for (const file of candidates) {
    try {
      const vars = parseDotenv(readFileSync(file, "utf8"));
      for (const [key, value] of Object.entries(vars)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      loaded.push(file);
    } catch {
      // 文件不存在 → 跳过（.env 是可选的，mock 供应商下无需任何配置）
    }
  }
  return loaded;
}
