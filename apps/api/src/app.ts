import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ArkPlanASRProvider,
  ArkPlanTTSProvider,
  MockASRProvider,
  MockLLMProvider,
  MockTTSProvider,
  OpenAICompatProvider,
  TaskRouter,
  lastUserText,
  type ASRProvider,
  type TTSProvider,
} from "@sema/ai-core";
import { ConversationService } from "./modules/conversation/service.js";
import { MemoryConversationRepo } from "./modules/conversation/repo.js";
import type { VADOptions } from "./modules/realtime/session.js";
import { WalletService } from "./modules/wallet/service.js";
import { MemoryWalletRepo } from "./modules/wallet/repo.js";
import { realtimeRoutes } from "./routes/realtime.js";
import { conversationRoutes } from "./routes/conversations.js";
import { healthRoutes } from "./routes/health.js";
import { walletRoutes } from "./routes/wallet.js";

declare module "fastify" {
  interface FastifyInstance {
    wallets: WalletService;
    conversations: ConversationService;
    speech: { asr: ASRProvider; tts: TTSProvider };
    vadOptions?: VADOptions;
  }
}

export interface BuildAppOptions {
  logger?: boolean;
  /** 测试注入的时钟（按秒累进计费的时间线） */
  now?: () => number;
  /** 测试注入的模型路由（默认按环境变量组装） */
  router?: TaskRouter;
  /** 测试注入的语音供应商（默认：有 Key 用方舟 plan 通道，否则 Mock） */
  speech?: { asr: ASRProvider; tts: TTSProvider };
  /** 测试校准的 VAD 灵敏度 */
  vad?: VADOptions;
}

/** 供应商路由组装：默认 mock（零成本开发/测试），配置 Key 即切真实模型 */
function defaultRouter(): TaskRouter {
  const provider = process.env.SEMA_LLM_PROVIDER ?? "mock";

  if (provider === "openai-compat") {
    const apiKey = process.env.SEMA_LLM_API_KEY ?? process.env.ARK_API_KEY ?? "";
    if (apiKey.length === 0) {
      throw new Error("SEMA_LLM_PROVIDER=openai-compat 需要 SEMA_LLM_API_KEY（或 ARK_API_KEY）");
    }
    const baseUrl =
      process.env.SEMA_LLM_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
    const model = process.env.SEMA_LLM_MODEL ?? "doubao-seed-flash";
    const flagship = new OpenAICompatProvider({ baseUrl, apiKey, model });
    // cheap 档：M1 先共用旗舰模型；M2 vocab 精讲接入时按量分档
    return new TaskRouter({ flagship, cheap: flagship });
  }

  // mock 教练：复述用户的话 + 鼓励追问，足够跑通开发与测试
  const flagship = new MockLLMProvider("mock-flagship", (messages) => {
    const said = lastUserText(messages);
    return `Nice one! You said: "${said.slice(0, 60)}". A native speaker might phrase that a little differently — could you tell me more?`;
  });
  const cheap = new MockLLMProvider("mock-cheap", () => "Memory hook saved. See you at review time!");
  return new TaskRouter({ flagship, cheap });
}

/** 语音供应商组装：有 Key 即切方舟 plan 通道（TTS/ASR），否则零成本 Mock */
function defaultSpeech(): { asr: ASRProvider; tts: TTSProvider } {
  const apiKey = process.env.SEMA_LLM_API_KEY ?? process.env.ARK_API_KEY ?? "";
  if (apiKey.length === 0) {
    return { asr: new MockASRProvider(), tts: new MockTTSProvider() };
  }
  const speaker = process.env.SEMA_TTS_SPEAKER;
  return {
    asr: new ArkPlanASRProvider({ apiKey }),
    tts: new ArkPlanTTSProvider({ apiKey, ...(speaker ? { speaker } : {}) }),
  };
}

/**
 * 组装 Fastify 应用。内存仓储跑通领域逻辑；Postgres 仓储
 * （@sema/db + drizzle）在接入真实数据库时替换注入，领域逻辑不变。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.decorate("wallets", new WalletService(new MemoryWalletRepo()));
  app.decorate(
    "conversations",
    new ConversationService(
      new MemoryConversationRepo(),
      app.wallets,
      options.router ?? defaultRouter(),
      options.now ?? Date.now,
    ),
  );
  app.decorate("speech", options.speech ?? defaultSpeech());
  app.decorate("vadOptions", options.vad);

  await app.register(healthRoutes);
  await app.register(walletRoutes, { prefix: "/v1/wallet" });
  await app.register(conversationRoutes, { prefix: "/v1/conversations" });
  await app.register(realtimeRoutes, { prefix: "/v1" });

  return app;
}
