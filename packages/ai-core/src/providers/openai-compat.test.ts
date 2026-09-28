import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "./mock.js";
import { OpenAICompatProvider } from "./openai-compat.js";

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = events.join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 故意把事件切在任意字节边界，验证跨包缓冲
      const mid = Math.floor(body.length / 3);
      controller.enqueue(encoder.encode(body.slice(0, mid)));
      controller.enqueue(encoder.encode(body.slice(mid)));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("OpenAICompatProvider SSE 流式解析", () => {
  it("跨包解析 delta 并采集 usage", async () => {
    const provider = new OpenAICompatProvider(
      { baseUrl: "https://fake.api/v3", apiKey: "test", model: "doubao-seed-flash" },
      async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo!"}}]}\n\n',
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ]),
    );

    const result = provider.chat({
      messages: [
        { role: "system", content: "you are a barista" },
        { role: "user", content: "hi" },
      ],
    });

    let text = "";
    for await (const chunk of result.chunks) text += chunk;
    expect(text).toBe("Hello!");
    expect(await result.usage()).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it("未回传 usage 时按 ~4 字符/token 估算", async () => {
    const provider = new OpenAICompatProvider(
      { baseUrl: "https://fake.api/v3", apiKey: "test", model: "m" },
      async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"abcdefgh"}}]}\n\n', // 8 chars → 2 tokens
          "data: [DONE]\n\n",
        ]),
    );

    const result = provider.chat({ messages: [{ role: "user", content: "abcdabcdabcdabcd" }] }); // 16 chars → 4
    for await (const _ of result.chunks) void _;
    const usage = await result.usage();
    expect(usage).toEqual({ promptTokens: 4, completionTokens: 2 });
  });

  it("上游 HTTP 错误抛出可读异常（供路由降级）", async () => {
    const provider = new OpenAICompatProvider(
      { baseUrl: "https://fake.api/v3", apiKey: "test", model: "m" },
      async () => new Response("rate limited", { status: 429 }),
    );

    const result = provider.chat({ messages: [{ role: "user", content: "hi" }] });
    await expect(async () => {
      for await (const _ of result.chunks) void _;
    }).rejects.toThrow(/429/);
  });

  it("MockLLMProvider 按词流式输出并估算用量", async () => {
    const provider = new MockLLMProvider("mock-flagship", () => "one two three");
    const result = provider.chat({ messages: [{ role: "user", content: "hello" }] });

    const parts: string[] = [];
    for await (const chunk of result.chunks) parts.push(chunk);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.join("")).toBe("one two three");

    const usage = await result.usage();
    expect(usage.completionTokens).toBeGreaterThan(0);
    expect(usage.promptTokens).toBeGreaterThan(0);
  });
});
