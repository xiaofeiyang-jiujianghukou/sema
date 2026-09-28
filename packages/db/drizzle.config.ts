import { defineConfig } from "drizzle-kit";

// DATABASE_URL 仅 drizzle-kit 本地操作需要（generate/migrate）
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/yanquan",
  },
});
