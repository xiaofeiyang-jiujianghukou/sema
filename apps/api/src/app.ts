import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
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
import { ASR_LANGUAGE } from "./content/scenarios.js";
import { ReviewService, MemoryReviewRepo } from "./modules/review/service.js";
import { VocabBookService, MemoryVocabRepo } from "./modules/vocab/service.js";
import { LectureService } from "./modules/vocab/lecture.js";
import { StatsService } from "./modules/stats/service.js";
import { AuthService, MemoryUserRepo, ConsoleSmsSender, type AccountDeletionRepos, type SmsSender } from "./modules/auth/service.js";
import { authRoutes } from "./routes/auth.js";
import type { VADOptions } from "./modules/realtime/session.js";
import { WalletService } from "./modules/wallet/service.js";
import { MemoryWalletRepo } from "./modules/wallet/repo.js";
import { DrizzleWalletRepo, DrizzleUserRepo } from "./modules/wallet/repo-pg.js";
import { realtimeRoutes } from "./routes/realtime.js";
import { reviewRoutes } from "./routes/review.js";
import { statsRoutes } from "./routes/stats.js";
import { conversationRoutes } from "./routes/conversations.js";
import { healthRoutes } from "./routes/health.js";
import { vocabRoutes } from "./routes/vocab.js";
import { walletRoutes } from "./routes/wallet.js";

declare module "fastify" {
  interface FastifyInstance {
    wallets: WalletService;
    accountDeletion: AccountDeletionRepos;
    conversations: ConversationService;
    reviews: ReviewService;
    vocabBook: VocabBookService;
    lectures: LectureService;
    stats: StatsService;
    auth: AuthService;
    speech: { asr: ASRProvider; tts: TTSProvider };
    /** 目标语言 → 语音参数（ASR 语言提示 + TTS 音色） */
    speechForLang: (lang: "en" | "ja" | "ko") => { language: string; speaker?: string };
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
  /** 短信发送器（测试注入固定验证码；生产接云短信） */
  smsSender?: SmsSender;
  /** 验证码生成器（测试用固定码；缺省随机） */
  smsCode?: () => string;
  /** Postgres 连接串；缺省用内存仓储（开发/测试），配置后走生产账本 */
  databaseUrl?: string;
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

  // 领域服务共享同一组仓储实例；Postgres 化逐仓储替换，领域逻辑不变
  const conversationRepo = new MemoryConversationRepo();
  const reviewRepo = new MemoryReviewRepo();
  const vocabRepo = new MemoryVocabRepo();
  const clock = options.now ?? Date.now;

  // 仓储装配：生产（DATABASE_URL）→ Postgres 账本；开发/测试 → 内存实现
  const dbPool = options.databaseUrl ? new Pool({ connectionString: options.databaseUrl }) : null;
  const walletRepo = dbPool ? new DrizzleWalletRepo(dbPool) : new MemoryWalletRepo();
  const userRepo = dbPool ? new DrizzleUserRepo(dbPool) : new MemoryUserRepo();

  app.decorate("wallets", new WalletService(walletRepo));
  app.decorate(
    "conversations",
    new ConversationService(
      conversationRepo,
      app.wallets,
      options.router ?? defaultRouter(),
      clock,
    ),
  );
  app.decorate("speech", options.speech ?? defaultSpeech());
  app.decorate("vadOptions", options.vad);

  // 目标语言 → 语音参数。ASR 语言提示显著影响识别准确率；TTS 音色按
  // SEMA_TTS_SPEAKER_EN/JA/KO 配置，未配置的语言回落默认音色（日/韩音色
  // 待真机联调时用真实音色 ID 验证后再固化默认值）。
  const SPEAKER_ENV: Record<"en" | "ja" | "ko", string | undefined> = {
    en: process.env.SEMA_TTS_SPEAKER_EN ?? process.env.SEMA_TTS_SPEAKER,
    ja: process.env.SEMA_TTS_SPEAKER_JA,
    ko: process.env.SEMA_TTS_SPEAKER_KO,
  };
  app.decorate("speechForLang", (lang: "en" | "ja" | "ko") => {
    const speaker = SPEAKER_ENV[lang];
    return {
      language: ASR_LANGUAGE[lang],
      ...(speaker ? { speaker } : {}),
    };
  });

  const vocabBook = new VocabBookService(vocabRepo, { now: clock });
  app.decorate("lectures", new LectureService({ repo: vocabRepo, wallets: app.wallets, router: options.router ?? defaultRouter() }));
  app.decorate("reviews", new ReviewService(reviewRepo, {
    conversations: conversationRepo,
    wallets: app.wallets,
    router: options.router ?? defaultRouter(),
    now: clock,
  }));
  app.decorate("vocabBook", vocabBook);
  app.decorate("stats", new StatsService(conversationRepo, reviewRepo, vocabBook, { now: clock }));

  app.decorate("accountDeletion", {
    conversationRepo,
    reviewRepo,
    vocabRepo,
    walletRepo,
    userRepo,
  } satisfies AccountDeletionRepos);
  app.decorate("auth", new AuthService({
    users: userRepo,
    sms: options.smsSender ?? new ConsoleSmsSender(),
    now: clock,
    ...(options.smsCode ? { codeFactory: options.smsCode } : {}),
  }));

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(walletRoutes, { prefix: "/v1/wallet" });
  await app.register(conversationRoutes, { prefix: "/v1/conversations" });
  await app.register(reviewRoutes, { prefix: "/v1" });
  await app.register(vocabRoutes, { prefix: "/v1" });
  await app.register(statsRoutes, { prefix: "/v1" });
  await app.register(realtimeRoutes, { prefix: "/v1" });

  return app;
}
