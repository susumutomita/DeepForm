import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process to prevent Keychain access in tests
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("no keychain in test");
  }),
}));

// Mock node:http before importing llm
vi.mock("node:http", () => {
  const request = vi.fn();
  return { default: { request }, request };
});

import http from "node:http";
import { callClaude, extractText } from "../llm.ts";

/**
 * Setup http.request mock to simulate a Node.js HTTP response stream.
 * The callback receives a mock response that fires 'data' and 'end' events.
 */
function setupHttpMock(responseData: string) {
  const reqHandlers: Record<string, Function> = {};
  const mockReq = {
    on: vi.fn((event: string, handler: Function) => {
      reqHandlers[event] = handler;
      return mockReq;
    }),
    setTimeout: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  };

  vi.mocked(http.request).mockImplementation((_options: any, callback: any) => {
    const handlers: Record<string, Function> = {};
    const mockRes = {
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
        return mockRes;
      },
    };
    callback(mockRes);
    handlers.data?.(responseData);
    handlers.end?.();
    return mockReq as any;
  });

  return { mockReq, reqHandlers };
}

describe("LLM モジュール", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("callClaude", () => {
    it("正常なレスポンスを返すべき", async () => {
      const expected = { content: [{ type: "text", text: "テスト回答" }] };
      setupHttpMock(JSON.stringify(expected));

      const result = await callClaude([{ role: "user", content: "テスト" }], "システムプロンプト");

      expect(result).toEqual(expected);
      expect(http.request).toHaveBeenCalledTimes(1);
    });

    it("API エラーレスポンスの場合にリジェクトすべき", async () => {
      setupHttpMock(JSON.stringify({ error: { message: "Rate limit exceeded" } }));

      await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow(
        "Rate limit exceeded",
      );
    });

    it("エラーメッセージが空の場合でもリジェクトすべき", async () => {
      setupHttpMock(JSON.stringify({ error: {} }));

      await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow();
    });

    it("不正な JSON レスポンスの場合にパースエラーでリジェクトすべき", async () => {
      setupHttpMock("this is not json");

      await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow(
        "Failed to parse LLM response",
      );
    });

    it("ネットワークエラーの場合にリジェクトすべき", async () => {
      const reqHandlers: Record<string, Function> = {};
      const mockReq = {
        on: vi.fn((event: string, handler: Function) => {
          reqHandlers[event] = handler;
          return mockReq;
        }),
        setTimeout: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      };

      vi.mocked(http.request).mockImplementation((_options: any, _callback: any) => {
        // Trigger error on next microtask so req.on('error') has registered
        Promise.resolve().then(() => {
          reqHandlers.error?.(new Error("ECONNREFUSED"));
        });
        return mockReq as any;
      });

      await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow("ECONNREFUSED");
    });
  });

  describe("extractText", () => {
    it("正常なレスポンスからテキストを結合して抽出すべき", () => {
      const response = {
        content: [
          { type: "text", text: "こんにちは" },
          { type: "text", text: "世界" },
        ],
      };
      expect(extractText(response)).toBe("こんにちは世界");
    });

    it("text 以外の type をフィルタリングすべき", () => {
      const response = {
        content: [
          { type: "text", text: "テスト" },
          { type: "image", text: "画像" },
          { type: "text", text: "追加" },
        ],
      };
      expect(extractText(response)).toBe("テスト追加");
    });

    it("空のコンテンツ配列の場合に空文字を返すべき", () => {
      expect(extractText({ content: [] })).toBe("");
    });

    it("null レスポンスの場合に空文字を返すべき", () => {
      expect(extractText(null as any)).toBe("");
    });

    it("undefined レスポンスの場合に空文字を返すべき", () => {
      expect(extractText(undefined as any)).toBe("");
    });

    it("content プロパティがないレスポンスの場合に空文字を返すべき", () => {
      expect(extractText({} as any)).toBe("");
    });

    it("text が undefined のコンテンツブロックを空文字として処理すべき", () => {
      const response = {
        content: [{ type: "text" }, { type: "text", text: "有効" }],
      };
      expect(extractText(response)).toBe("有効");
    });
  });
});
