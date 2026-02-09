import http from 'node:http';

const LLM_GATEWAY = 'http://169.254.169.254/gateway/llm/anthropic/v1/messages';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

export function callClaude(messages: ClaudeMessage[], system: string, maxTokens = 4096): Promise<ClaudeResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system,
      messages,
    });

    const url = new URL(LLM_GATEWAY);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
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

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function extractText(response: ClaudeResponse): string {
  if (!response?.content) return '';
  return response.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}
