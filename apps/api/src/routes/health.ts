import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({
    ok: true,
    name: "yanquan",
    service: "api",
    time: new Date().toISOString(),
  }));
};
