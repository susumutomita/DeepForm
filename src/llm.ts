import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const LLM_GATEWAY = "http://169.254.169.254/gateway/llm/anthropic/v1/messages";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

// --- Token Management ---

let cachedToken: string | null = null;

function isOAuthToken(key: string): boolean {
  return key.startsWith("sk-ant-oat");
}

function readKeychainToken(): string | null {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function getAPIKey(): string | null {
  if (cachedToken) return cachedToken;

  // Try Keychain (macOS)
  const keychainToken = readKeychainToken();
  if (keychainToken) {
    cachedToken = keychainToken;
    return cachedToken;
  }

  // Fall back to env
  cachedToken = process.env.ANTHROPIC_API_KEY ?? null;
  return cachedToken;
}

function refreshAPIKey(): string | null {
  const old = cachedToken;
  cachedToken = null;
  const fresh = readKeychainToken();
  if (fresh && fresh !== old) {
    console.info("OAuth token refreshed from Keychain");
    cachedToken = fresh;
    return cachedToken;
  }
  return null;
}

// --- Endpoint Selection ---

function resolveEndpoint(): { url: URL; apiKey: string | null } {
  const apiKey = getAPIKey();

  // ローカル: API キーがあれば直接 Anthropic API を使う
  if (apiKey) {
    const endpoint = process.env.ANTHROPIC_ENDPOINT ?? ANTHROPIC_API;
    let urlStr = endpoint;
    if (isOAuthToken(apiKey) && !urlStr.includes("beta=true")) {
      urlStr += urlStr.includes("?") ? "&beta=true" : "?beta=true";
    }
    return { url: new URL(urlStr), apiKey };
  }

  // 本番 (exe.dev): LLM Gateway — API キー不要
  return { url: new URL(LLM_GATEWAY), apiKey: null };
}

// --- Request Builder ---

function buildHeaders(apiKey: string | null, bodyLength: number): Record<string, string | number> {
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "Content-Length": bodyLength,
  };

  if (apiKey) {
    if (isOAuthToken(apiKey)) {
      headers.Authorization = `Bearer ${apiKey}`;
      headers["anthropic-beta"] = "oauth-2025-04-20,interleaved-thinking-2025-05-14";
      headers["User-Agent"] = "claude-cli/2.1.2 (external, cli)";
    } else {
      headers["x-api-key"] = apiKey;
    }
  }

  return headers;
}

function buildSystemPrompt(apiKey: string | null, system: string): string | Array<{ type: string; text: string }> {
  if (apiKey && isOAuthToken(apiKey)) {
    return [
      { type: "text", text: CLAUDE_CODE_PREFIX },
      { type: "text", text: system },
    ];
  }
  return system;
}

// --- LLM Call ---

function doRequest(endpoint: { url: URL; apiKey: string | null }, body: string): Promise<ClaudeResponse> {
  return new Promise((resolve, reject) => {
    const { url, apiKey } = endpoint;
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST" as const,
      headers: buildHeaders(apiKey, Buffer.byteLength(body)),
    };

    const authMethod = apiKey ? (isOAuthToken(apiKey) ? "oauth" : "apikey") : "gateway";
    console.info(`LLM request: ${url.hostname} auth=${authMethod}`);

    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as ClaudeResponse;
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse LLM response: ${data.substring(0, 500)}`));
        }
      });
    });

    req.setTimeout(180_000, () => {
      req.destroy(new Error("LLM request timed out after 180s"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function callClaude(messages: ClaudeMessage[], system: string, maxTokens = 4096): Promise<ClaudeResponse> {
  const endpoint = resolveEndpoint();
  const body = JSON.stringify({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",
    max_tokens: maxTokens,
    system: buildSystemPrompt(endpoint.apiKey, system),
    messages,
  });

  try {
    return await doRequest(endpoint, body);
  } catch (err) {
    // 401 + OAuth → Keychain からトークンを再取得して 1 回リトライ
    if (endpoint.apiKey && isOAuthToken(endpoint.apiKey) && err instanceof Error && err.message.includes("401")) {
      const newKey = refreshAPIKey();
      if (newKey) {
        const retryEndpoint = resolveEndpoint();
        const retryBody = JSON.stringify({
          model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",
          max_tokens: maxTokens,
          system: buildSystemPrompt(retryEndpoint.apiKey, system),
          messages,
        });
        return doRequest(retryEndpoint, retryBody);
      }
      throw new Error("OAuth token expired and refresh failed");
    }
    throw err;
  }
}

// --- Streaming LLM Call ---

export function callClaudeStream(
  messages: ClaudeMessage[],
  system: string,
  maxTokens = 4096,
): { stream: import("node:stream").Readable; getFullText: () => string } {
  const endpoint = resolveEndpoint();
  const body = JSON.stringify({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",
    max_tokens: maxTokens,
    stream: true,
    system: buildSystemPrompt(endpoint.apiKey, system),
    messages,
  });

  const readable = new Readable({ read() {} });
  let fullText = "";

  const { url, apiKey } = endpoint;
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: "POST" as const,
    headers: buildHeaders(apiKey, Buffer.byteLength(body)),
  };

  const authMethod = apiKey ? (isOAuthToken(apiKey) ? "oauth" : "apikey") : "gateway";
  console.info(`LLM stream request: ${url.hostname} auth=${authMethod}`);

  const req = transport.request(options, (res) => {
    let buffer = "";
    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            readable.push(null);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
              fullText += parsed.delta.text;
              readable.push(parsed.delta.text);
            } else if (parsed.type === "message_stop") {
              readable.push(null);
            } else if (parsed.error) {
              readable.destroy(new Error(parsed.error.message || "LLM error"));
            }
          } catch {
            // skip unparseable lines
          }
        }
      }
    });
    res.on("end", () => {
      if (!readable.destroyed) readable.push(null);
    });
    res.on("error", (err) => readable.destroy(err));
  });

  req.setTimeout(180_000, () => {
    req.destroy(new Error("LLM stream request timed out after 180s"));
  });
  req.on("error", (err) => readable.destroy(err));
  req.write(body);
  req.end();

  return { stream: readable, getFullText: () => fullText };
}

export function extractText(response: ClaudeResponse): string {
  if (!response?.content) return "";
  return response.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}
