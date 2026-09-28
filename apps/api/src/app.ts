import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  MockLLMProvider,
  OpenAICompatProvider,
  TaskRouter,
  lastUserText,
} from "@sema/ai-core";
import { ConversationService } from "./modules/conversation/service.js";
import { MemoryConversationRepo } from "./modules/conversation/repo.js";
import { WalletService } from "./modules/wallet/service.js";
import { MemoryWalletRepo } from "./modules/wallet/repo.js";
import { conversationRoutes } from "./routes/conversations.js";
import { healthRoutes } from "./routes/health.js";
import { walletRoutes } from "./routes/wallet.js";

declare module "fastify" {
  interface FastifyInstance {
    wallets: WalletService;
    conversations: ConversationService;
  }
}

export interface BuildAppOptions {
  logger?: boolean;
  /** 测试注入的时钟（按秒累进计费的时间线） */
  now?: () => number;
  /** 测试注入的模型路由（默认按环境变量组装） */
  router?: TaskRouter;
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

/**
 * 组装 Fastify 应用。内存仓储跑通领域逻辑；Postgres 仓储
 * （@sema/db + drizzle）在接入真实数据库时替换注入，领域逻辑不变。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, { origin: true });

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

  await app.register(healthRoutes);
  await app.register(walletRoutes, { prefix: "/v1/wallet" });
  await app.register(conversationRoutes, { prefix: "/v1/conversations" });

  return app;
}
