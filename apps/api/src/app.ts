import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { WalletService } from "./modules/wallet/service.js";
import { MemoryWalletRepo } from "./modules/wallet/repo.js";
import { healthRoutes } from "./routes/health.js";
import { walletRoutes } from "./routes/wallet.js";

declare module "fastify" {
  interface FastifyInstance {
    wallets: WalletService;
  }
}

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * 组装 Fastify 应用。M0 用内存仓储；Postgres 仓储（@sema/db + drizzle）
 * 在接入真实数据库时替换注入，领域逻辑不变。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, { origin: true });

  const repo = new MemoryWalletRepo();
  app.decorate("wallets", new WalletService(repo));

  await app.register(healthRoutes);
  await app.register(walletRoutes, { prefix: "/v1/wallet" });

  return app;
}
