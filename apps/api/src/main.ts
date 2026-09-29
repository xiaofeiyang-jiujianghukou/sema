import { buildApp } from "./app.js";
import { loadEnvFiles } from "./env.js";

const loadedFrom = loadEnvFiles();
const provider = process.env.SEMA_LLM_PROVIDER ?? "mock";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

// DATABASE_URL 配置即切换 Postgres 仓储（账号/账本持久化）；缺省内存实现
const databaseUrl = process.env.DATABASE_URL;

const app = await buildApp({ logger: true, ...(databaseUrl ? { databaseUrl } : {}) });

if (databaseUrl) app.log.info("仓储: Postgres（DATABASE_URL 已配置，重启不丢数据）");
else app.log.info("仓储: 内存（开发/测试；重启清空）");

await app.listen({ port: PORT, host: HOST });
app.log.info(
  { provider, model: process.env.SEMA_LLM_MODEL ?? "(mock 内置)", envFiles: loadedFrom },
  `说嘛 API 已启动 · LLM 供应商: ${provider}`,
);
