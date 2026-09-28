import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = await buildApp({ logger: true });

await app.listen({ port: PORT, host: HOST });
