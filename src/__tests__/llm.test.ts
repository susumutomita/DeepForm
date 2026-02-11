import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("no keychain in test");
  }),
}));

vi.mock("node:http", () => {
  const request = vi.fn();
  return { default: { request }, request };
});

vi.mock("node:https", () => {
  const request = vi.fn();
  return { default: { request }, request };
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Re-import everything from a clean module cache so `cachedToken` resets. */
async function freshImport() {
  vi.resetModules();
  const cp = await import("node:child_process");
  const httpMod = await import("node:http");
  const httpsMod = await import("node:https");
  const llm = await import("../llm.ts");
  return {
    execFileSync: cp.execFileSync as unknown as ReturnType<typeof vi.fn>,
    http: httpMod.default as unknown as TransportLike,
    https: httpsMod.default as unknown as TransportLike,
    callClaude: llm.callClaude,
    extractText: llm.extractText,
  };
}

interface TransportLike {
  request: ReturnType<typeof vi.fn>;
}

function setupTransportMock(transport: TransportLike, responseData: string) {
  const reqHandlers: Record<string, Function> = {};
  const mockReq = {
    on: vi.fn((event: string, handler: Function) => {
      reqHandlers[event] = handler;
      return mockReq;
    }),
    setTimeout: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };

  transport.request.mockImplementation((_options: any, callback: any) => {
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

function setupTransportError(transport: TransportLike, error: Error) {
  const reqHandlers: Record<string, Function> = {};
  const mockReq = {
    on: vi.fn((event: string, handler: Function) => {
      reqHandlers[event] = handler;
      return mockReq;
    }),
    setTimeout: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };

  transport.request.mockImplementation((_options: any, _callback: any) => {
    Promise.resolve().then(() => {
      reqHandlers.error?.(error);
    });
    return mockReq as any;
  });

  return { mockReq, reqHandlers };
}

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_ENDPOINT", "ANTHROPIC_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

function saveAndClearEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv() {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

describe("LLM モジュール", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveAndClearEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  /* ---------------------------------------------------------------- */
  /*  callClaude                                                       */
  /* ---------------------------------------------------------------- */
  describe("callClaude", () => {
    describe("ゲートウェイモード（APIキーなし）", () => {
      it("正常なレスポンスを返すべき", async () => {
        // Given:
        const { callClaude, http } = await freshImport();
        const expected = { content: [{ type: "text", text: "回答" }] };
        setupTransportMock(http, JSON.stringify(expected));

        // When:
        const result = await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        expect(result).toEqual(expected);
      });

      it("http トランスポートを使用してゲートウェイに接続すべき", async () => {
        // Given:
        const { callClaude, http } = await freshImport();
        setupTransportMock(http, JSON.stringify({ content: [] }));

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        expect(http.request).toHaveBeenCalledTimes(1);
        const opts = http.request.mock.calls[0][0];
        expect(opts.hostname).toBe("169.254.169.254");
      });

      it("APIエラーレスポンスのメッセージでリジェクトすべき", async () => {
        // Given:
        const { callClaude, http } = await freshImport();
        setupTransportMock(http, JSON.stringify({ error: { message: "Rate limit exceeded" } }));

        // When / Then:
        await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow(
          "Rate limit exceeded",
        );
      });

      it("エラーメッセージが空の場合でもリジェクトすべき", async () => {
        // Given:
        const { callClaude, http } = await freshImport();
        setupTransportMock(http, JSON.stringify({ error: {} }));

        // When / Then:
        await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow();
      });

      it("不正なJSONレスポンスの場合にパースエラーでリジェクトすべき", async () => {
        // Given:
        const { callClaude, http } = await freshImport();
        setupTransportMock(http, "this is not json");

        // When / Then:
        await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow(
          "Failed to parse LLM response",
        );
      });

      it("ネットワークエラーの場合にリジェクトすべき", async () => {
        // Given:
        const { callClaude, http } = await freshImport();
        setupTransportError(http, new Error("ECONNREFUSED"));

        // When / Then:
        await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow("ECONNREFUSED");
      });

      it("タイムアウト時にリクエストを破棄すべき", async () => {
        // Given:
        const { callClaude, http } = await freshImport();
        const reqHandlers: Record<string, Function> = {};
        const mockReq = {
          on: vi.fn((event: string, handler: Function) => {
            reqHandlers[event] = handler;
            return mockReq;
          }),
          setTimeout: vi.fn((_ms: number, cb: Function) => {
            // fire the timeout callback immediately
            Promise.resolve().then(() => cb());
          }),
          write: vi.fn(),
          end: vi.fn(),
          destroy: vi.fn((err: Error) => {
            // destroy triggers the error handler
            Promise.resolve().then(() => reqHandlers.error?.(err));
          }),
        };
        http.request.mockImplementation((_options: any, _callback: any) => mockReq as any);

        // When / Then:
        await expect(callClaude([{ role: "user", content: "テスト" }], "プロンプト")).rejects.toThrow(
          "LLM request timed out after 180s",
        );
      });
    });

    describe("通常APIキーモード", () => {
      it("httpsトランスポートでAnthropicAPIに接続すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-api01-regular-key";
        const { callClaude, https } = await freshImport();
        setupTransportMock(https, JSON.stringify({ content: [] }));

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        const opts = https.request.mock.calls[0][0];
        expect(opts.hostname).toBe("api.anthropic.com");
      });

      it("x-api-keyヘッダーを設定すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-api01-regular-key";
        const { callClaude, https } = await freshImport();
        setupTransportMock(https, JSON.stringify({ content: [] }));

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        const opts = https.request.mock.calls[0][0];
        expect(opts.headers["x-api-key"]).toBe("sk-ant-api01-regular-key");
      });

      it("systemプロンプトを文字列として送信すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-api01-regular-key";
        const { callClaude, https } = await freshImport();
        let writtenBody = "";
        const reqHandlers: Record<string, Function> = {};
        const mockReq = {
          on: vi.fn((event: string, handler: Function) => {
            reqHandlers[event] = handler;
            return mockReq;
          }),
          setTimeout: vi.fn(),
          write: vi.fn((b: string) => {
            writtenBody = b;
          }),
          end: vi.fn(),
          destroy: vi.fn(),
        };
        https.request.mockImplementation((_options: any, callback: any) => {
          const handlers: Record<string, Function> = {};
          const mockRes = {
            on: (event: string, handler: Function) => {
              handlers[event] = handler;
              return mockRes;
            },
          };
          callback(mockRes);
          handlers.data?.(JSON.stringify({ content: [] }));
          handlers.end?.();
          return mockReq as any;
        });

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "マイシステム");

        // Then:
        const parsed = JSON.parse(writtenBody);
        expect(parsed.system).toBe("マイシステム");
      });
    });

    describe("OAuthトークンモード", () => {
      it("BearerトークンとOAuthヘッダーを設定すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-oat-test-oauth-token";
        const { callClaude, https } = await freshImport();
        setupTransportMock(https, JSON.stringify({ content: [] }));

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        const opts = https.request.mock.calls[0][0];
        expect(opts.headers.Authorization).toBe("Bearer sk-ant-oat-test-oauth-token");
        expect(opts.headers["anthropic-beta"]).toBe("oauth-2025-04-20,interleaved-thinking-2025-05-14");
        expect(opts.headers["User-Agent"]).toBe("claude-cli/2.1.2 (external, cli)");
      });

      it("URLにbeta=trueクエリパラメータを付与すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-oat-test-oauth-token";
        const { callClaude, https } = await freshImport();
        setupTransportMock(https, JSON.stringify({ content: [] }));

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        const opts = https.request.mock.calls[0][0];
        expect(opts.path).toContain("?beta=true");
      });

      it("systemプロンプトをClaudeCodeプレフィックス付き配列で送信すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-oat-test-oauth-token";
        const { callClaude, https } = await freshImport();
        let writtenBody = "";
        const reqHandlers: Record<string, Function> = {};
        const mockReq = {
          on: vi.fn((event: string, handler: Function) => {
            reqHandlers[event] = handler;
            return mockReq;
          }),
          setTimeout: vi.fn(),
          write: vi.fn((b: string) => {
            writtenBody = b;
          }),
          end: vi.fn(),
          destroy: vi.fn(),
        };
        https.request.mockImplementation((_options: any, callback: any) => {
          const handlers: Record<string, Function> = {};
          const mockRes = {
            on: (event: string, handler: Function) => {
              handlers[event] = handler;
              return mockRes;
            },
          };
          callback(mockRes);
          handlers.data?.(JSON.stringify({ content: [] }));
          handlers.end?.();
          return mockReq as any;
        });

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "マイシステム");

        // Then:
        const parsed = JSON.parse(writtenBody);
        expect(parsed.system).toEqual([
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: "マイシステム" },
        ]);
      });
    });

    describe("カスタムエンドポイント", () => {
      it("ANTHROPIC_ENDPOINTで指定されたURLを使用すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-api01-regular-key";
        process.env.ANTHROPIC_ENDPOINT = "https://custom.example.com/v1/messages";
        const { callClaude, https } = await freshImport();
        setupTransportMock(https, JSON.stringify({ content: [] }));

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        const opts = https.request.mock.calls[0][0];
        expect(opts.hostname).toBe("custom.example.com");
      });

      it("OAuthトークン＋既存クエリ文字列の場合に&beta=trueを付与すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-oat-test-oauth-token";
        process.env.ANTHROPIC_ENDPOINT = "https://custom.example.com/v1/messages?version=2";
        const { callClaude, https } = await freshImport();
        setupTransportMock(https, JSON.stringify({ content: [] }));

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        const opts = https.request.mock.calls[0][0];
        expect(opts.path).toContain("?version=2&beta=true");
      });

      it("beta=trueが既に含まれている場合は重複付与しないこと", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-oat-test-oauth-token";
        process.env.ANTHROPIC_ENDPOINT = "https://custom.example.com/v1/messages?beta=true";
        const { callClaude, https } = await freshImport();
        setupTransportMock(https, JSON.stringify({ content: [] }));

        // When:
        await callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        const opts = https.request.mock.calls[0][0];
        const betaCount = (opts.path.match(/beta=true/g) || []).length;
        expect(betaCount).toBe(1);
      });
    });

    describe("Keychainトークン取得", () => {
      it("Keychainから有効なOAuthトークンを取得して使用すべき", async () => {
        // Given:
        const mods = await freshImport();
        mods.execFileSync.mockReturnValue(
          JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-keychain-token" } }),
        );
        // Need to re-import llm AFTER configuring mock, so resetModules again
        vi.resetModules();
        const httpsMod = await import("node:https");
        const llm = await import("../llm.ts");
        setupTransportMock(httpsMod.default as any, JSON.stringify({ content: [] }));

        // When:
        await llm.callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        const opts = (httpsMod.default as any).request.mock.calls[0][0];
        expect(opts.headers.Authorization).toBe("Bearer sk-ant-oat-keychain-token");
      });

      it("Keychainが不正なJSONを返す場合にnullとして扱うべき", async () => {
        // Given:
        const mods = await freshImport();
        mods.execFileSync.mockReturnValue("not-json-at-all");
        vi.resetModules();
        const httpMod = await import("node:http");
        const llm = await import("../llm.ts");
        setupTransportMock(httpMod.default as any, JSON.stringify({ content: [] }));

        // When: (falls through to gateway since no env key either)
        await llm.callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then: uses gateway (http), not API
        expect((httpMod.default as any).request).toHaveBeenCalledTimes(1);
      });

      it("Keychainにネストされたプロパティが欠損している場合にnullとして扱うべき", async () => {
        // Given:
        const mods = await freshImport();
        mods.execFileSync.mockReturnValue(JSON.stringify({ other: "data" }));
        vi.resetModules();
        const httpMod = await import("node:http");
        const llm = await import("../llm.ts");
        setupTransportMock(httpMod.default as any, JSON.stringify({ content: [] }));

        // When:
        await llm.callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then: falls through to gateway
        const opts = (httpMod.default as any).request.mock.calls[0][0];
        expect(opts.hostname).toBe("169.254.169.254");
      });
    });

    describe("キャッシュされたトークン", () => {
      it("2回目の呼び出しでキャッシュされたトークンを使用すべき", async () => {
        // Given:
        process.env.ANTHROPIC_API_KEY = "sk-ant-api01-cached-key";
        const { callClaude, https, execFileSync } = await freshImport();
        setupTransportMock(https, JSON.stringify({ content: [] }));

        // When: call twice
        await callClaude([{ role: "user", content: "1" }], "システム");
        await callClaude([{ role: "user", content: "2" }], "システム");

        // Then: execFileSync is only called once (first getAPIKey), not on second
        // Actually keychain is tried first, fails, then env is cached.
        // Second call returns cachedToken immediately — no keychain call.
        expect(execFileSync).toHaveBeenCalledTimes(1);
      });
    });

    describe("OAuth 401リトライ", () => {
      it("401エラー後にトークンをリフレッシュしてリトライすべき", async () => {
        // Given: OAuth token via env, keychain fails on first call
        process.env.ANTHROPIC_API_KEY = "sk-ant-oat-old-token";
        const mods = await freshImport();
        let callCount = 0;
        let keychainCallCount = 0;

        // getAPIKey: keychain throws (call 1) → falls to env var
        // refreshAPIKey: keychain returns new token (call 2)
        mods.execFileSync.mockImplementation(() => {
          keychainCallCount++;
          if (keychainCallCount <= 1) throw new Error("no keychain");
          return JSON.stringify({
            claudeAiOauth: { accessToken: "sk-ant-oat-new-token" },
          });
        });

        mods.https.request.mockImplementation((_options: any, callback: any) => {
          callCount++;
          const reqHandlers: Record<string, Function> = {};
          const mockReq = {
            on: vi.fn((event: string, handler: Function) => {
              reqHandlers[event] = handler;
              return mockReq;
            }),
            setTimeout: vi.fn(),
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
          };

          const handlers: Record<string, Function> = {};
          const mockRes = {
            on: (event: string, handler: Function) => {
              handlers[event] = handler;
              return mockRes;
            },
          };
          callback(mockRes);

          if (callCount === 1) {
            // First call: 401 error
            handlers.data?.(JSON.stringify({ error: { message: "401 Unauthorized" } }));
          } else {
            // Retry: success
            handlers.data?.(JSON.stringify({ content: [{ type: "text", text: "成功" }] }));
          }
          handlers.end?.();
          return mockReq as any;
        });

        // When:
        const result = await mods.callClaude([{ role: "user", content: "テスト" }], "システム");

        // Then:
        expect(result.content[0].text).toBe("成功");
        expect(callCount).toBe(2);
      });

      it("リフレッシュ失敗時にOAuthトークン期限切れエラーを投げるべき", async () => {
        // Given: OAuth token, but keychain returns nothing on refresh
        process.env.ANTHROPIC_API_KEY = "sk-ant-oat-expired-token";
        const mods = await freshImport();

        // execFileSync always throws (no new token from keychain)
        mods.execFileSync.mockImplementation(() => {
          throw new Error("no keychain");
        });

        // First call returns 401
        mods.https.request.mockImplementation((_options: any, callback: any) => {
          const reqHandlers: Record<string, Function> = {};
          const mockReq = {
            on: vi.fn((event: string, handler: Function) => {
              reqHandlers[event] = handler;
              return mockReq;
            }),
            setTimeout: vi.fn(),
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
          };
          const handlers: Record<string, Function> = {};
          const mockRes = {
            on: (event: string, handler: Function) => {
              handlers[event] = handler;
              return mockRes;
            },
          };
          callback(mockRes);
          handlers.data?.(JSON.stringify({ error: { message: "401 Unauthorized" } }));
          handlers.end?.();
          return mockReq as any;
        });

        // When / Then:
        await expect(mods.callClaude([{ role: "user", content: "テスト" }], "システム")).rejects.toThrow(
          "OAuth token expired and refresh failed",
        );
      });

      it("非OAuthトークンの401エラーはリトライせずに再スローすべき", async () => {
        // Given: regular (non-OAuth) API key
        process.env.ANTHROPIC_API_KEY = "sk-ant-api01-regular-key";
        const { callClaude, https } = await freshImport();
        setupTransportMock(https, JSON.stringify({ error: { message: "401 Unauthorized" } }));

        // When / Then:
        await expect(callClaude([{ role: "user", content: "テスト" }], "システム")).rejects.toThrow("401 Unauthorized");
        // Only one call — no retry
        expect(https.request).toHaveBeenCalledTimes(1);
      });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  extractText                                                      */
  /* ---------------------------------------------------------------- */
  describe("extractText", () => {
    // extractText is a pure function — use a single import
    let extractText: Awaited<ReturnType<typeof freshImport>>["extractText"];

    beforeEach(async () => {
      const mods = await freshImport();
      extractText = mods.extractText;
    });

    it("複数テキストブロックを結合して抽出すべき", () => {
      // Given:
      const response = {
        content: [
          { type: "text", text: "こんにちは" },
          { type: "text", text: "世界" },
        ],
      };

      // When:
      const result = extractText(response);

      // Then:
      expect(result).toBe("こんにちは世界");
    });

    it("text以外のtypeをフィルタリングすべき", () => {
      // Given:
      const response = {
        content: [
          { type: "text", text: "テスト" },
          { type: "image", text: "画像" },
          { type: "text", text: "追加" },
        ],
      };

      // When:
      const result = extractText(response);

      // Then:
      expect(result).toBe("テスト追加");
    });

    it("空のコンテンツ配列の場合に空文字を返すべき", () => {
      // Given:
      const response = { content: [] };

      // When:
      const result = extractText(response);

      // Then:
      expect(result).toBe("");
    });

    it("nullレスポンスの場合に空文字を返すべき", () => {
      // Given / When:
      const result = extractText(null as any);

      // Then:
      expect(result).toBe("");
    });

    it("undefinedレスポンスの場合に空文字を返すべき", () => {
      // Given / When:
      const result = extractText(undefined as any);

      // Then:
      expect(result).toBe("");
    });

    it("contentプロパティがないレスポンスの場合に空文字を返すべき", () => {
      // Given / When:
      const result = extractText({} as any);

      // Then:
      expect(result).toBe("");
    });

    it("textがundefinedのコンテンツブロックを空文字として処理すべき", () => {
      // Given:
      const response = {
        content: [{ type: "text" }, { type: "text", text: "有効" }],
      };

      // When:
      const result = extractText(response);

      // Then:
      expect(result).toBe("有効");
    });
  });
});
