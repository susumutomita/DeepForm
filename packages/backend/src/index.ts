import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import Database from "better-sqlite3";
import crypto from "crypto";
import OpenAI from "openai";

// ─── Database Setup ───────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, "..", "deepform.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS analysis_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`);

// ─── Prepared Statements ──────────────────────────────────────────────────────

const stmts = {
  insertSession: db.prepare("INSERT INTO sessions (id, theme) VALUES (?, ?)"),
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  getMessages: db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC"
  ),
  insertMessage: db.prepare(
    "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
  ),
  countUserMessages: db.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND role = 'user'"
  ),
  getAnalysis: db.prepare(
    "SELECT * FROM analysis_results WHERE session_id = ? AND type = ?"
  ),
  insertAnalysis: db.prepare(
    "INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)"
  ),
  deleteAnalysis: db.prepare(
    "DELETE FROM analysis_results WHERE session_id = ? AND type = ?"
  ),
  getAllAnalysis: db.prepare(
    "SELECT * FROM analysis_results WHERE session_id = ? ORDER BY created_at ASC"
  ),
  updateSessionTimestamp: db.prepare(
    "UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
}

function getOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

function getSessionOrThrow(sessionId: string) {
  const session = stmts.getSession.get(sessionId) as any;
  if (!session) {
    const err: any = new Error(`Session not found: ${sessionId}`);
    err.status = 404;
    throw err;
  }
  return session;
}

function saveAnalysis(sessionId: string, type: string, data: unknown) {
  stmts.deleteAnalysis.run(sessionId, type);
  stmts.insertAnalysis.run(sessionId, type, JSON.stringify(data));
  stmts.updateSessionTimestamp.run(sessionId);
}

// ─── System Prompts ───────────────────────────────────────────────────────────

function interviewerSystemPrompt(theme: string): string {
  return `あなたは熟練のデプスインタビュアーです。ユーザーの課題テーマについて深掘りインタビューを行います。

ルール：
1. 一度に1つの質問だけ聞く
2. 具体的なエピソードを引き出す（「最近あった具体例を教えてください」）
3. 頻度・困り度・現在の回避策を必ず聞く
4. 抽象的な回答には「具体的には？」で掘り下げる
5. 共感を示しながら深掘りする
6. 5回以上のやり取りで十分な情報が集まったら、分析に進む準備ができたことを示す

テーマ: ${theme}`;
}

const FACT_EXTRACTION_PROMPT = `以下のインタビュー記録からファクトを抽出してください。

各ファクトは以下の形式でJSON配列として返してください:
{
  "type": "fact" | "pain" | "frequency" | "workaround",
  "content": "抽出した内容",
  "evidence": "元の発話（引用）",
  "severity": "high" | "medium" | "low"
}

抽象的な表現は避け、具体的な事実のみ抽出してください。
JSON配列のみを返してください。マークダウンのコードブロックは不要です。`;

const HYPOTHESIS_PROMPT = `以下のファクト一覧から仮説を生成してください。

各仮説は以下の形式でJSON配列として返してください:
{
  "title": "仮説のタイトル",
  "description": "仮説の詳細説明",
  "supportingFacts": ["根拠となるファクトの内容"],
  "counterEvidence": "反証や注意点",
  "unverifiedPoints": ["まだ検証されていない点"]
}

JSON配列のみを返してください。マークダウンのコードブロックは不要です。`;

const PRD_PROMPT = `以下のファクトと仮説に基づいて、PRD（プロダクト要求仕様書）を生成してください。

以下のJSON形式で返してください:
{
  "problemDefinition": "解決する課題の定義",
  "targetUser": "ターゲットユーザー像",
  "jobsToBeDone": ["ユーザーが達成したいジョブ"],
  "coreFeatures": [{"name": "機能名", "description": "説明", "priority": "must|should|could"}],
  "nonGoals": ["スコープ外の事項"],
  "userFlows": [{"name": "フロー名", "steps": ["ステップ"]}],
  "acceptanceCriteria": ["受け入れ基準"],
  "metrics": [{"name": "指標名", "description": "説明", "target": "目標値"}]
}

JSONオブジェクトのみを返してください。マークダウンのコードブロックは不要です。`;

const SPEC_PROMPT = `以下のPRDに基づいて、実装仕様書を生成してください。

以下のJSON形式で返してください:
{
  "specJson": {
    "overview": "システム概要",
    "architecture": "アーキテクチャ説明",
    "techStack": ["使用技術"],
    "components": [{"name": "コンポーネント名", "responsibility": "責務"}]
  },
  "prdMarkdown": "PRDのMarkdown形式の文書",
  "apiSpec": {
    "endpoints": [{"method": "GET|POST|PUT|DELETE", "path": "/api/...", "description": "説明", "requestBody": {}, "responseBody": {}}]
  },
  "dbSchema": "CREATE TABLE文を含むDBスキーマ定義",
  "screens": [{"name": "画面名", "description": "説明", "components": ["含まれるUIコンポーネント"], "actions": ["ユーザーアクション"]}],
  "testCases": [{"name": "テストケース名", "description": "説明", "steps": ["手順"], "expected": "期待結果"}]
}

JSONオブジェクトのみを返してください。マークダウンのコードブロックは不要です。`;

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// Serve frontend static files
const frontendDistPath = path.join(__dirname, "..", "..", "frontend", "dist");
app.use(express.static(frontendDistPath));

// ─── API Routes ───────────────────────────────────────────────────────────────

// POST /api/sessions - Create a new session
app.post("/api/sessions", (req: Request, res: Response) => {
  try {
    const { theme } = req.body;
    if (!theme || typeof theme !== "string") {
      res.status(400).json({ error: "theme is required and must be a string" });
      return;
    }

    const sessionId = crypto.randomUUID();
    stmts.insertSession.run(sessionId, theme.trim());
    log(`Session created: ${sessionId}, theme: ${theme}`);

    res.status(201).json({ sessionId, theme: theme.trim() });
  } catch (err: any) {
    log("Error creating session:", err.message);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// GET /api/sessions/:id - Get session with all data
app.get("/api/sessions/:id", (req: Request, res: Response) => {
  try {
    const session = stmts.getSession.get(paramId(req)) as any;
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const messages = stmts.getMessages.all(paramId(req)) as any[];
    const analysisRows = stmts.getAllAnalysis.all(paramId(req)) as any[];

    const analysis: Record<string, unknown> = {};
    for (const row of analysisRows) {
      analysis[row.type] = JSON.parse(row.data);
    }

    res.json({
      ...session,
      messages,
      facts: analysis["facts"] || null,
      hypotheses: analysis["hypotheses"] || null,
      prd: analysis["prd"] || null,
      spec: analysis["spec"] || null,
    });
  } catch (err: any) {
    log("Error getting session:", err.message);
    res.status(500).json({ error: "Failed to get session" });
  }
});

// POST /api/sessions/:id/chat - Send a chat message
app.post("/api/sessions/:id/chat", async (req: Request, res: Response) => {
  try {
    const { message, apiKey } = req.body;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (!apiKey || typeof apiKey !== "string") {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }

    const session = getSessionOrThrow(paramId(req));

    // Save user message
    stmts.insertMessage.run(session.id, "user", message.trim());

    // Build conversation history
    const messages = stmts.getMessages.all(session.id) as any[];
    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: interviewerSystemPrompt(session.theme) },
      ...messages.map((m: any) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    // Call OpenAI
    const openai = getOpenAIClient(apiKey);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: chatMessages,
      temperature: 0.7,
      max_tokens: 1024,
    });

    const reply = completion.choices[0]?.message?.content || "";

    // Save assistant message
    stmts.insertMessage.run(session.id, "assistant", reply);
    stmts.updateSessionTimestamp.run(session.id);

    // Check turn count
    const turnCountRow = stmts.countUserMessages.get(session.id) as any;
    const turnCount = turnCountRow?.count || 0;
    const readyForAnalysis = turnCount >= 5;

    log(
      `Chat in session ${session.id}: turn ${turnCount}, readyForAnalysis: ${readyForAnalysis}`
    );

    res.json({ reply, turnCount, readyForAnalysis });
  } catch (err: any) {
    log("Error in chat:", err.message);
    if (err.status === 404) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.status === 401 || err.code === "invalid_api_key") {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    res.status(500).json({ error: "Failed to process chat message" });
  }
});

// POST /api/sessions/:id/analyze - Extract facts
app.post("/api/sessions/:id/analyze", async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }

    const session = getSessionOrThrow(paramId(req));
    const messages = stmts.getMessages.all(session.id) as any[];

    if (messages.length === 0) {
      res.status(400).json({ error: "No messages in session to analyze" });
      return;
    }

    // Format conversation
    const transcript = messages
      .map(
        (m: any) =>
          `${m.role === "user" ? "ユーザー" : "インタビュアー"}: ${m.content}`
      )
      .join("\n\n");

    const openai = getOpenAIClient(apiKey);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: FACT_EXTRACTION_PROMPT },
        { role: "user", content: transcript },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });

    const raw = completion.choices[0]?.message?.content || "[]";
    let facts: any[];
    try {
      // Strip markdown code block fences if present
      const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
      facts = JSON.parse(cleaned);
    } catch {
      log("Failed to parse facts JSON, raw:", raw);
      facts = [];
    }

    // Add IDs
    facts = facts.map((f: any, i: number) => ({
      id: `fact-${i + 1}`,
      type: f.type || "fact",
      content: f.content || "",
      evidence: f.evidence || "",
      severity: f.severity || "medium",
    }));

    // Save to DB
    saveAnalysis(session.id, "facts", facts);
    log(`Extracted ${facts.length} facts for session ${session.id}`);

    res.json(facts);
  } catch (err: any) {
    log("Error in analyze:", err.message);
    if (err.status === 404) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Failed to analyze session" });
  }
});

// POST /api/sessions/:id/hypotheses - Generate hypotheses
app.post(
  "/api/sessions/:id/hypotheses",
  async (req: Request, res: Response) => {
    try {
      const { apiKey } = req.body;
      if (!apiKey) {
        res.status(400).json({ error: "apiKey is required" });
        return;
      }

      const session = getSessionOrThrow(paramId(req));

      // Get facts
      const factsRow = stmts.getAnalysis.get(session.id, "facts") as any;
      if (!factsRow) {
        res
          .status(400)
          .json({ error: "No facts found. Run analyze first." });
        return;
      }
      const facts = JSON.parse(factsRow.data);

      const factsText = facts
        .map(
          (f: any, i: number) =>
            `${i + 1}. [${f.type}][${f.severity}] ${f.content} (根拠: ${f.evidence})`
        )
        .join("\n");

      const openai = getOpenAIClient(apiKey);
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: HYPOTHESIS_PROMPT },
          { role: "user", content: factsText },
        ],
        temperature: 0.5,
        max_tokens: 4096,
      });

      const raw = completion.choices[0]?.message?.content || "[]";
      let hypotheses: any[];
      try {
        const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
        hypotheses = JSON.parse(cleaned);
      } catch {
        log("Failed to parse hypotheses JSON, raw:", raw);
        hypotheses = [];
      }

      // Add IDs
      hypotheses = hypotheses.map((h: any, i: number) => ({
        id: `hyp-${i + 1}`,
        title: h.title || "",
        description: h.description || "",
        supportingFacts: h.supportingFacts || [],
        counterEvidence: h.counterEvidence || "",
        unverifiedPoints: h.unverifiedPoints || [],
      }));

      saveAnalysis(session.id, "hypotheses", hypotheses);
      log(
        `Generated ${hypotheses.length} hypotheses for session ${session.id}`
      );

      res.json({ hypotheses });
    } catch (err: any) {
      log("Error in hypotheses:", err.message);
      if (err.status === 404) {
        res.status(404).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Failed to generate hypotheses" });
    }
  }
);

// POST /api/sessions/:id/prd - Generate PRD
app.post("/api/sessions/:id/prd", async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }

    const session = getSessionOrThrow(paramId(req));

    // Get facts and hypotheses
    const factsRow = stmts.getAnalysis.get(session.id, "facts") as any;
    const hypRow = stmts.getAnalysis.get(session.id, "hypotheses") as any;

    if (!factsRow || !hypRow) {
      res.status(400).json({
        error: "Facts and hypotheses required. Run analyze and hypotheses first.",
      });
      return;
    }

    const facts = JSON.parse(factsRow.data);
    const hypotheses = JSON.parse(hypRow.data);

    const context = `## テーマ\n${session.theme}\n\n## ファクト\n${JSON.stringify(facts, null, 2)}\n\n## 仮説\n${JSON.stringify(hypotheses, null, 2)}`;

    const openai = getOpenAIClient(apiKey);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: PRD_PROMPT },
        { role: "user", content: context },
      ],
      temperature: 0.4,
      max_tokens: 4096,
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    let prd: any;
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
      prd = JSON.parse(cleaned);
    } catch {
      log("Failed to parse PRD JSON, raw:", raw);
      prd = { error: "Failed to parse PRD", raw };
    }

    saveAnalysis(session.id, "prd", prd);
    log(`Generated PRD for session ${session.id}`);

    res.json(prd);
  } catch (err: any) {
    log("Error in PRD:", err.message);
    if (err.status === 404) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Failed to generate PRD" });
  }
});

// POST /api/sessions/:id/spec - Generate implementation spec
app.post("/api/sessions/:id/spec", async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }

    const session = getSessionOrThrow(paramId(req));

    // Get PRD
    const prdRow = stmts.getAnalysis.get(session.id, "prd") as any;
    if (!prdRow) {
      res.status(400).json({ error: "PRD required. Run prd generation first." });
      return;
    }

    const prd = JSON.parse(prdRow.data);

    const context = `## テーマ\n${session.theme}\n\n## PRD\n${JSON.stringify(prd, null, 2)}`;

    const openai = getOpenAIClient(apiKey);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SPEC_PROMPT },
        { role: "user", content: context },
      ],
      temperature: 0.3,
      max_tokens: 8192,
    });

    const raw = completion.choices[0]?.message?.content || "{}";
    let spec: any;
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
      spec = JSON.parse(cleaned);
    } catch {
      log("Failed to parse spec JSON, raw:", raw);
      spec = { error: "Failed to parse spec", raw };
    }

    saveAnalysis(session.id, "spec", spec);
    log(`Generated spec for session ${session.id}`);

    res.json(spec);
  } catch (err: any) {
    log("Error in spec:", err.message);
    if (err.status === 404) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Failed to generate spec" });
  }
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────

app.get("/{*path}", (_req: Request, res: Response) => {
  const indexPath = path.join(frontendDistPath, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: "Not found" });
    }
  });
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  log("Unhandled error:", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = 8000;
app.listen(PORT, () => {
  log(`DeepForm backend server running on http://localhost:${PORT}`);
  log(`Serving frontend from: ${frontendDistPath}`);
  log(`Database: ${DB_PATH}`);
});

export default app;
