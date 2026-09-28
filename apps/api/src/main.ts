import { buildApp } from "./app.js";
import { loadEnvFiles } from "./env.js";

const loadedFrom = loadEnvFiles();
const provider = process.env.SEMA_LLM_PROVIDER ?? "mock";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = await buildApp({ logger: true });

await app.listen({ port: PORT, host: HOST });
app.log.info(
  { provider, model: process.env.SEMA_LLM_MODEL ?? "(mock 内置)", envFiles: loadedFrom },
  `说嘛 API 已启动 · LLM 供应商: ${provider}`,
);
