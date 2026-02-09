const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const http = require('http');

const app = express();
const PORT = 8000;

// --- Database Setup ---
const db = new Database(path.join(__dirname, '..', 'data', 'deepform.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'interviewing',
    mode TEXT NOT NULL DEFAULT 'self',
    share_token TEXT UNIQUE,
    respondent_name TEXT,
    respondent_feedback TEXT,
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

// Migration: add columns if they don't exist
try { db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'self'"); } catch(e) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN share_token TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN respondent_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN respondent_feedback TEXT'); } catch(e) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token)'); } catch(e) {}

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- LLM Gateway ---
const LLM_GATEWAY = 'http://169.254.169.254/gateway/llm/anthropic/v1/messages';

function callClaude(messages, system, maxTokens = 4096) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: system,
      messages: messages,
    });

    const url = new URL(LLM_GATEWAY);
    const options = {
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
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse LLM response: ${data.substring(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractText(response) {
  if (!response || !response.content) return '';
  return response.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');
}

// --- API Routes ---

// Create session
app.post('/api/sessions', (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || !theme.trim()) {
      return res.status(400).json({ error: 'テーマを入力してください' });
    }
    const id = uuidv4();
    db.prepare('INSERT INTO sessions (id, theme) VALUES (?, ?)').run(id, theme.trim());
    res.json({ sessionId: id, theme: theme.trim() });
  } catch (e) {
    console.error('Create session error:', e);
    res.status(500).json({ error: e.message });
  }
});

// List sessions
app.get('/api/sessions', (req, res) => {
  try {
    const sessions = db.prepare(
      'SELECT s.*, COUNT(m.id) as message_count FROM sessions s LEFT JOIN messages m ON s.id = m.session_id GROUP BY s.id ORDER BY s.updated_at DESC'
    ).all();
    // Also include respondent_done as analyzed for developer view
    sessions.forEach(s => {
      if (s.status === 'respondent_done') s.display_status = 'analyzed';
    });
    res.json(sessions);
  } catch (e) {
    console.error('List sessions error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get session
app.get('/api/sessions/:id', (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at').all(req.params.id);
    const analyses = db.prepare('SELECT * FROM analysis_results WHERE session_id = ? ORDER BY created_at').all(req.params.id);

    const analysisMap = {};
    for (const a of analyses) {
      analysisMap[a.type] = JSON.parse(a.data);
    }

    res.json({ ...session, messages, analysis: analysisMap });
  } catch (e) {
    console.error('Get session error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Chat in interview
app.post('/api/sessions/:id/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Save user message
    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'user', message);
    db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

    // Build conversation history
    const allMessages = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at').all(req.params.id);
    const chatMessages = allMessages.map(m => ({ role: m.role, content: m.content }));

    const turnCount = allMessages.filter(m => m.role === 'user').length;

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。ユーザーの課題テーマについて深掘りインタビューを行います。

テーマ: 「${session.theme}」

ルール：
1. 一度に1つの質問だけ聞く
2. 具体的なエピソードを引き出す（「最近あった具体例を教えてください」）
3. 頻度・困り度・現在の回避策を必ず聞く
4. 抽象的な回答には「具体的には？」で掘り下げる
5. 共感を示しながら深掘りする
6. 日本語で回答する
7. 回答は簡潔に、200文字以内で

${turnCount >= 5 ? '十分な情報が集まりました。最後にまとめの質問をして、回答の最後に「[READY_FOR_ANALYSIS]」タグを付けてください。ただし、ユーザーがまだ話したそうなら続けてください。' : ''}`;

    const response = await callClaude(chatMessages, systemPrompt, 1024);
    const reply = extractText(response);

    // Save assistant message
    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'assistant', reply);

    const readyForAnalysis = reply.includes('[READY_FOR_ANALYSIS]') || turnCount >= 8;
    const cleanReply = reply.replace('[READY_FOR_ANALYSIS]', '').trim();

    res.json({ reply: cleanReply, turnCount, readyForAnalysis });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Start interview (get first question)
app.post('/api/sessions/:id/start', async (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const existingMessages = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(req.params.id);
    if (existingMessages.count > 0) {
      return res.json({ reply: 'インタビューは既に開始されています。', alreadyStarted: true });
    }

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。これからユーザーの課題テーマについて深掘りインタビューを開始します。

テーマ: 「${session.theme}」

最初の質問を1つだけ聞いてください。テーマについて、まず現状の状況を理解するための質問をしてください。
共感的で親しみやすいトーンで、日本語で話してください。200文字以内で。`;

    const response = await callClaude(
      [{ role: 'user', content: `テーマ「${session.theme}」についてインタビューを始めてください。` }],
      systemPrompt,
      512
    );
    const reply = extractText(response);

    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'assistant', reply);

    res.json({ reply });
  } catch (e) {
    console.error('Start interview error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Analyze: Extract facts
app.post('/api/sessions/:id/analyze', async (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const messages = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at').all(req.params.id);
    const transcript = messages.map(m => `${m.role === 'user' ? '回答者' : 'インタビュアー'}: ${m.content}`).join('\n\n');

    const systemPrompt = `あなたは定性調査の分析エキスパートです。以下のデプスインタビュー記録からファクトを抽出してください。

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "facts": [
    {
      "id": "F1",
      "type": "fact",
      "content": "抽出した内容",
      "evidence": "元の発話を引用",
      "severity": "high"
    }
  ]
}

typeは "fact"（事実）, "pain"（困りごと）, "frequency"（頻度）, "workaround"（回避策）のいずれか。
severityは "high", "medium", "low" のいずれか。

抽象的な表現は避け、具体的な事実のみ抽出してください。最低5つ、最大15個のファクトを抽出してください。`;

    const response = await callClaude(
      [{ role: 'user', content: `以下のインタビュー記録を分析してください：\n\n${transcript}` }],
      systemPrompt,
      4096
    );
    const text = extractText(response);

    let facts;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      facts = JSON.parse(jsonMatch[0]);
    } catch (e) {
      facts = { facts: [{ id: 'F1', type: 'fact', content: text, evidence: '', severity: 'medium' }] };
    }

    // Save analysis
    const existing = db.prepare('SELECT id FROM analysis_results WHERE session_id = ? AND type = ?').get(req.params.id, 'facts');
    if (existing) {
      db.prepare('UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(facts), existing.id);
    } else {
      db.prepare('INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)').run(req.params.id, 'facts', JSON.stringify(facts));
    }

    db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('analyzed', req.params.id);
    res.json(facts);
  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generate hypotheses
app.post('/api/sessions/:id/hypotheses', async (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const factsRow = db.prepare('SELECT data FROM analysis_results WHERE session_id = ? AND type = ?').get(req.params.id, 'facts');
    if (!factsRow) return res.status(400).json({ error: 'ファクト抽出を先に実行してください' });

    const facts = JSON.parse(factsRow.data);

    const systemPrompt = `あなたはプロダクト仮説生成のエキスパートです。抽出されたファクトから仮説を生成してください。

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "hypotheses": [
    {
      "id": "H1",
      "title": "仮説タイトル",
      "description": "仮説の詳細説明",
      "supportingFacts": ["F1", "F3"],
      "counterEvidence": "この仮説が成り立たない可能性",
      "unverifiedPoints": ["未検証ポイント1"]
    }
  ]
}

3つの仮説を生成してください。各仮説に：
- 根拠となるファクトID
- 反証パターン
- 未検証ポイント
を必ず含めてください。`;

    const response = await callClaude(
      [{ role: 'user', content: `以下のファクトから仮説を生成してください：\n\n${JSON.stringify(facts, null, 2)}` }],
      systemPrompt,
      4096
    );
    const text = extractText(response);

    let hypotheses;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      hypotheses = JSON.parse(jsonMatch[0]);
    } catch (e) {
      hypotheses = { hypotheses: [{ id: 'H1', title: text, description: '', supportingFacts: [], counterEvidence: '', unverifiedPoints: [] }] };
    }

    const existing = db.prepare('SELECT id FROM analysis_results WHERE session_id = ? AND type = ?').get(req.params.id, 'hypotheses');
    if (existing) {
      db.prepare('UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(hypotheses), existing.id);
    } else {
      db.prepare('INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)').run(req.params.id, 'hypotheses', JSON.stringify(hypotheses));
    }

    db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('hypothesized', req.params.id);
    res.json(hypotheses);
  } catch (e) {
    console.error('Hypotheses error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generate PRD
app.post('/api/sessions/:id/prd', async (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const factsRow = db.prepare('SELECT data FROM analysis_results WHERE session_id = ? AND type = ?').get(req.params.id, 'facts');
    const hypothesesRow = db.prepare('SELECT data FROM analysis_results WHERE session_id = ? AND type = ?').get(req.params.id, 'hypotheses');
    if (!factsRow || !hypothesesRow) return res.status(400).json({ error: '先にファクト抽出と仮説生成を実行してください' });

    const facts = JSON.parse(factsRow.data);
    const hypotheses = JSON.parse(hypothesesRow.data);

    const systemPrompt = `あなたはシニアプロダクトマネージャーです。ファクトと仮説からPRD（プロダクト要件定義書）を生成してください。

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "prd": {
    "problemDefinition": "解決する問題の具体的な定義",
    "targetUser": "対象ユーザーの具体的な描写",
    "jobsToBeDone": ["ジョブ1", "ジョブ2"],
    "coreFeatures": [
      {
        "name": "機能名",
        "description": "機能の説明",
        "priority": "must",
        "acceptanceCriteria": ["受け入れ基準1"],
        "edgeCases": ["エッジケース: 入力が空の場合はエラーメッセージを表示"]
      }
    ],
    "nonGoals": ["やらないこと1"],
    "userFlows": [
      {
        "name": "フロー名",
        "steps": ["ステップ1", "ステップ2"]
      }
    ],
    "qualityRequirements": {
      "functionalSuitability": {
        "description": "機能適合性に関する要件",
        "criteria": ["主要ユースケースの全パスが正常に完了すること"]
      },
      "performanceEfficiency": {
        "description": "性能効率性に関する要件",
        "criteria": ["API応答は95パーセンタイルで2秒以内"]
      },
      "compatibility": {
        "description": "互換性に関する要件",
        "criteria": ["Chrome/Safari/Firefox最新版で動作"]
      },
      "usability": {
        "description": "使用性に関する要件",
        "criteria": ["初回ユーザーが説明なしで主要操作を完了できる"]
      },
      "reliability": {
        "description": "信頼性に関する要件",
        "criteria": ["月間稼働率99.5%以上"]
      },
      "security": {
        "description": "セキュリティに関する要件",
        "criteria": ["入力値はすべてサーバーサイドで検証"]
      },
      "maintainability": {
        "description": "保守性に関する要件",
        "criteria": ["主要モジュールのユニットテストカバレッジ80%以上"]
      },
      "portability": {
        "description": "移植性に関する要件",
        "criteria": ["Docker Composeで環境を再現可能"]
      }
    },
    "metrics": [
      {
        "name": "指標名",
        "definition": "計測方法",
        "target": "目標値"
      }
    ]
  }
}

ルール：
- 抽象語は禁止（「改善する」「最適化する」などNG）
- テスト可能な条件のみ記述
- MVP スコープに圧縮（コア機能は最大5つ）
- 各機能に受け入れ基準を必ず付ける
- 各機能にエッジケース（異常入力、境界値、同時操作、権限不足、ネットワーク断など）を必ず列挙する
- qualityRequirements は ISO/IEC 25010 の8品質特性すべてを網羅し、テーマに合った具体的な基準を書く
  1. functionalSuitability（機能適合性）: 機能完全性、正確性、適切性
  2. performanceEfficiency（性能効率性）: 時間効率性、資源効率性、容量
  3. compatibility（互換性）: 共存性、相互運用性
  4. usability（使用性）: 認識性、習得性、操作性、エラー防止、UI美観、アクセシビリティ
  5. reliability（信頼性）: 成熟性、可用性、障害許容性、回復性
  6. security（セキュリティ）: 機密性、完全性、否認防止、責任追跡性、真正性
  7. maintainability（保守性）: モジュール性、再利用性、解析性、修正性、試験性
  8. portability（移植性）: 適応性、設置性、置換性`;

    const response = await callClaude(
      [{ role: 'user', content: `以下のファクトと仮説からPRDを生成してください：\n\nテーマ: ${session.theme}\n\nファクト:\n${JSON.stringify(facts, null, 2)}\n\n仮説:\n${JSON.stringify(hypotheses, null, 2)}` }],
      systemPrompt,
      8192
    );
    const text = extractText(response);

    let prd;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      prd = JSON.parse(jsonMatch[0]);
    } catch (e) {
      prd = { prd: { problemDefinition: text, targetUser: '', jobsToBeDone: [], coreFeatures: [], nonGoals: [], userFlows: [], metrics: [] } };
    }

    const existing = db.prepare('SELECT id FROM analysis_results WHERE session_id = ? AND type = ?').get(req.params.id, 'prd');
    if (existing) {
      db.prepare('UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(prd), existing.id);
    } else {
      db.prepare('INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)').run(req.params.id, 'prd', JSON.stringify(prd));
    }

    db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('prd_generated', req.params.id);
    res.json(prd);
  } catch (e) {
    console.error('PRD error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generate implementation spec
app.post('/api/sessions/:id/spec', async (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const prdRow = db.prepare('SELECT data FROM analysis_results WHERE session_id = ? AND type = ?').get(req.params.id, 'prd');
    if (!prdRow) return res.status(400).json({ error: '先にPRD生成を実行してください' });

    const prd = JSON.parse(prdRow.data);

    const systemPrompt = `あなたはテックリードです。PRDからコーディングエージェント向けの実装仕様を生成してください。

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "spec": {
    "projectName": "プロジェクト名",
    "techStack": {
      "frontend": "技術スタック",
      "backend": "技術スタック",
      "database": "データベース"
    },
    "apiEndpoints": [
      {
        "method": "GET",
        "path": "/api/xxx",
        "description": "説明",
        "request": {},
        "response": {}
      }
    ],
    "dbSchema": "CREATE TABLE ...",
    "screens": [
      {
        "name": "画面名",
        "path": "/path",
        "components": ["コンポーネント1"],
        "description": "画面の説明"
      }
    ],
    "testCases": [
      {
        "category": "カテゴリ",
        "cases": [
          {
            "name": "テスト名",
            "given": "前提条件",
            "when": "操作",
            "then": "期待結果"
          }
        ]
      }
    ]
  }
}

ルール：
- 具体的なAPI仕様（メソッド、パス、リクエスト/レスポンス形式）
- 具体的なDBスキーマ（CREATE TABLE文）
- 画面一覧と主要コンポーネント
- テストケース（Given-When-Then形式）
- コーディングエージェントがそのまま実装に着手できるレベルの具体性`;

    const response = await callClaude(
      [{ role: 'user', content: `以下のPRDから実装仕様を生成してください：\n\n${JSON.stringify(prd, null, 2)}` }],
      systemPrompt,
      8192
    );
    const text = extractText(response);

    let spec;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      spec = JSON.parse(jsonMatch[0]);
    } catch (e) {
      spec = { spec: { raw: text } };
    }

    // Also generate PRD markdown
    const prdData = prd.prd || prd;
    const prdMarkdown = generatePRDMarkdown(prdData, session.theme);
    spec.prdMarkdown = prdMarkdown;

    const existing = db.prepare('SELECT id FROM analysis_results WHERE session_id = ? AND type = ?').get(req.params.id, 'spec');
    if (existing) {
      db.prepare('UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(spec), existing.id);
    } else {
      db.prepare('INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)').run(req.params.id, 'spec', JSON.stringify(spec));
    }

    db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('spec_generated', req.params.id);
    res.json(spec);
  } catch (e) {
    console.error('Spec error:', e);
    res.status(500).json({ error: e.message });
  }
});

function generatePRDMarkdown(prd, theme) {
  const qrLabels = {
    functionalSuitability: '機能適合性',
    performanceEfficiency: '性能効率性',
    compatibility: '互換性',
    usability: '使用性',
    reliability: '信頼性',
    security: 'セキュリティ',
    maintainability: '保守性',
    portability: '移植性',
  };
  const qrSection = prd.qualityRequirements ? Object.entries(qrLabels).map(([key, label]) => {
    const item = prd.qualityRequirements[key];
    if (!item) return '';
    return `### ${label}\n${item.description || ''}\n${(item.criteria || []).map(c => `- ${c}`).join('\n')}`;
  }).filter(Boolean).join('\n\n') : '';

  return `# PRD: ${theme}

## 問題定義
${prd.problemDefinition || ''}

## 対象ユーザー
${prd.targetUser || ''}

## Jobs to be Done
${(prd.jobsToBeDone || []).map((j, i) => `${i + 1}. ${j}`).join('\n')}

## コア機能（MVP）
${(prd.coreFeatures || []).map(f => `### ${f.name}\n${f.description}\n\n**優先度**: ${f.priority}\n\n**受け入れ基準**:\n${(f.acceptanceCriteria || []).map(a => `- ${a}`).join('\n')}\n\n**エッジケース**:\n${(f.edgeCases || []).map(e => `- ${e}`).join('\n')}`).join('\n\n')}

## Non-Goals（やらないこと）
${(prd.nonGoals || []).map(n => `- ${n}`).join('\n')}

## ユーザーフロー
${(prd.userFlows || []).map(f => `### ${f.name}\n${(f.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`).join('\n\n')}

## 非機能要件（ISO/IEC 25010）
${qrSection}

## 計測指標
| 指標 | 定義 | 目標 |
|------|------|------|
${(prd.metrics || []).map(m => `| ${m.name} | ${m.definition} | ${m.target} |`).join('\n')}
`;
}

// ==========================================
// Shared Interview API (respondent-facing)
// ==========================================

// Generate share token for a session
app.post('/api/sessions/:id/share', (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.share_token) {
      return res.json({ shareToken: session.share_token, theme: session.theme });
    }

    // Generate short readable token
    const token = uuidv4().split('-')[0];
    db.prepare('UPDATE sessions SET share_token = ?, mode = ? WHERE id = ?').run(token, 'shared', req.params.id);

    res.json({ shareToken: token, theme: session.theme });
  } catch (e) {
    console.error('Share error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get shared session info (public, limited)
app.get('/api/shared/:token', (req, res) => {
  try {
    const session = db.prepare('SELECT id, theme, status, share_token, respondent_name FROM sessions WHERE share_token = ?').get(req.params.token);
    if (!session) return res.status(404).json({ error: 'Interview not found' });

    const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id).count;
    const factsRow = db.prepare('SELECT data FROM analysis_results WHERE session_id = ? AND type = ?').get(session.id, 'facts');

    res.json({
      theme: session.theme,
      status: session.status,
      respondentName: session.respondent_name,
      messageCount,
      facts: factsRow ? JSON.parse(factsRow.data) : null,
    });
  } catch (e) {
    console.error('Get shared error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Start shared interview
app.post('/api/shared/:token/start', async (req, res) => {
  try {
    const { respondentName } = req.body;
    const session = db.prepare('SELECT * FROM sessions WHERE share_token = ?').get(req.params.token);
    if (!session) return res.status(404).json({ error: 'Interview not found' });

    // Save respondent name if provided
    if (respondentName) {
      db.prepare('UPDATE sessions SET respondent_name = ? WHERE id = ?').run(respondentName.trim(), session.id);
    }

    // Check if already started
    const existing = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id);
    if (existing.count > 0) {
      const messages = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at').all(session.id);
      return res.json({ reply: messages[0]?.content || '', alreadyStarted: true, messages });
    }

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。これからユーザーの課題テーマについて深掘りインタビューを開始します。

テーマ: 「${session.theme}」
${respondentName ? `回答者: ${respondentName}さん` : ''}

最初の質問を1つだけ聞いてください。テーマについて、まず現状の状況を理解するための質問をしてください。
共感的で親しみやすいトーンで、日本語で話してください。200文字以内で。`;

    const response = await callClaude(
      [{ role: 'user', content: `テーマ「${session.theme}」についてインタビューを始めてください。` }],
      systemPrompt,
      512
    );
    const reply = extractText(response);

    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(session.id, 'assistant', reply);
    db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('interviewing', session.id);

    res.json({ reply });
  } catch (e) {
    console.error('Start shared interview error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Chat in shared interview
app.post('/api/shared/:token/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const session = db.prepare('SELECT * FROM sessions WHERE share_token = ?').get(req.params.token);
    if (!session) return res.status(404).json({ error: 'Interview not found' });

    // Don't allow chat after completion
    if (session.status === 'respondent_done') {
      return res.status(400).json({ error: 'このインタビューは既に完了しています' });
    }

    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(session.id, 'user', message);
    db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(session.id);

    const allMessages = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at').all(session.id);
    const chatMessages = allMessages.map(m => ({ role: m.role, content: m.content }));
    const turnCount = allMessages.filter(m => m.role === 'user').length;

    const systemPrompt = `あなたは熟練のデプスインタビュアーです。ユーザーの課題テーマについて深掘りインタビューを行います。

テーマ: 「${session.theme}」

ルール：
1. 一度に1つの質問だけ聞く
2. 具体的なエピソードを引き出す（「最近あった具体例を教えてください」）
3. 頻度・困り度・現在の回避策を必ず聞く
4. 抽象的な回答には「具体的には？」で掘り下げる
5. 共感を示しながら深掘りする
6. 日本語で回答する
7. 回答は簡潔に、200文字以内で

${turnCount >= 5 ? '十分な情報が集まりました。最後にまとめの質問をして、回答の最後に「[INTERVIEW_COMPLETE]」タグを付けてください。ただし、ユーザーがまだ話したそうなら続けてください。' : ''}`;

    const response = await callClaude(chatMessages, systemPrompt, 1024);
    const reply = extractText(response);

    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(session.id, 'assistant', reply);

    const isComplete = reply.includes('[INTERVIEW_COMPLETE]') || turnCount >= 8;
    const cleanReply = reply.replace('[INTERVIEW_COMPLETE]', '').trim();

    res.json({ reply: cleanReply, turnCount, isComplete });
  } catch (e) {
    console.error('Shared chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Complete shared interview: extract facts and finish
app.post('/api/shared/:token/complete', async (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE share_token = ?').get(req.params.token);
    if (!session) return res.status(404).json({ error: 'Interview not found' });

    const messages = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at').all(session.id);
    const transcript = messages.map(m => `${m.role === 'user' ? '回答者' : 'インタビュアー'}: ${m.content}`).join('\n\n');

    const systemPrompt = `あなたは定性調査の分析エキスパートです。以下のデプスインタビュー記録からファクトを抽出してください。

必ず以下のJSON形式で返してください。JSON以外のテキストは含めないでください。

{
  "facts": [
    {
      "id": "F1",
      "type": "fact",
      "content": "抽出した内容",
      "evidence": "元の発話を引用",
      "severity": "high"
    }
  ]
}

typeは "fact"（事実）, "pain"（困りごと）, "frequency"（頻度）, "workaround"（回避策）のいずれか。
severityは "high", "medium", "low" のいずれか。

抽象的な表現は避け、具体的な事実のみ抽出してください。最低5つ、最大15個のファクトを抽出してください。`;

    const response = await callClaude(
      [{ role: 'user', content: `以下のインタビュー記録を分析してください：\n\n${transcript}` }],
      systemPrompt,
      4096
    );
    const text = extractText(response);

    let facts;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      facts = JSON.parse(jsonMatch[0]);
    } catch (e) {
      facts = { facts: [{ id: 'F1', type: 'fact', content: text, evidence: '', severity: 'medium' }] };
    }

    // Save facts
    const existing = db.prepare('SELECT id FROM analysis_results WHERE session_id = ? AND type = ?').get(session.id, 'facts');
    if (existing) {
      db.prepare('UPDATE analysis_results SET data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(facts), existing.id);
    } else {
      db.prepare('INSERT INTO analysis_results (session_id, type, data) VALUES (?, ?, ?)').run(session.id, 'facts', JSON.stringify(facts));
    }

    db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('respondent_done', session.id);

    res.json(facts);
  } catch (e) {
    console.error('Complete shared error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Save respondent feedback on facts
app.post('/api/shared/:token/feedback', (req, res) => {
  try {
    const { feedback } = req.body;
    const session = db.prepare('SELECT * FROM sessions WHERE share_token = ?').get(req.params.token);
    if (!session) return res.status(404).json({ error: 'Interview not found' });

    db.prepare('UPDATE sessions SET respondent_feedback = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(feedback, 'respondent_done', session.id);

    res.json({ ok: true });
  } catch (e) {
    console.error('Feedback error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Delete session
app.delete('/api/sessions/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM analysis_results WHERE session_id = ?').run(req.params.id);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(req.params.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete session error:', e);
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`DeepForm server running on http://localhost:${PORT}`);
});
