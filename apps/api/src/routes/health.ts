import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({
    ok: true,
    name: "sema",
    service: "api",
    time: new Date().toISOString(),
  }));
};
