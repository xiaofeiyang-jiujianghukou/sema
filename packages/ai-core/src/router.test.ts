import { describe, expect, it } from "vitest";
import { TaskRouter } from "./router.js";
import { MockLLMProvider } from "./providers/mock.js";
import type { ChatRequest } from "./types.js";

const flagship = new MockLLMProvider("mock-flagship");
const cheap = new MockLLMProvider("mock-cheap");
const router = new TaskRouter({ flagship, cheap });

const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

describe("TaskRouter 任务分级路由", () => {
  it("dialogue / review → flagship 档", async () => {
    expect(router.route("dialogue").tier).toBe("flagship");
    expect(router.route("review").tier).toBe("flagship");

    // chat() 便捷方法走同一档位
    const result = router.chat("dialogue", req);
    let text = "";
    for await (const chunk of result.chunks) text += chunk;
    expect(text.length).toBeGreaterThan(0);
    const usage = await result.usage();
    expect(usage.completionTokens).toBeGreaterThan(0);
  });

  it("vocab → cheap 档（成本差价关键路径）", () => {
    expect(router.route("vocab").tier).toBe("cheap");
    expect(router.route("vocab").provider.model).toBe("mock-cheap");
  });
});
