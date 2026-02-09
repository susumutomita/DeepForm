# デッドコード除去 + Hono 移行 + GitHub OAuth 認証 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** テンプレート残骸を除去し、Express を Hono + TypeScript に移行し、GitHub OAuth 認証を追加する

**Architecture:** `src/server.js`（1186行のモノリシック Express サーバー）を Hono + TypeScript に移行し、責務ごとにファイル分割する。認証は `@hono/oauth-providers` で GitHub OAuth を実装し、セッションをユーザーに紐づける。フロントエンドは `public/` の vanilla JS をそのまま維持する。

**Tech Stack:** Hono, @hono/node-server, @hono/oauth-providers, better-sqlite3, tsx, TypeScript

---

### Task 1: デッドコード除去

`packages/`, `contracts/` のテンプレート残骸を削除し、`package.json` と `Makefile` のスクリプトを整理する。

**Files:**
- Delete: `packages/frontend/` (ディレクトリごと)
- Delete: `packages/backend/` (ディレクトリごと)
- Delete: `contracts/` (ディレクトリごと)
- Modify: `package.json`
- Modify: `Makefile`
- Modify: `.lintstagedrc.json`

**Step 1: テンプレートディレクトリを削除**

ユーザーに以下の削除を依頼する（`rm` コマンド使用禁止のため）。
または `git rm -r` で Git 追跡から削除する。

```bash
git rm -r packages/
git rm -r contracts/
```

**Step 2: `package.json` のスクリプトを整理**

不要なスクリプトを削除し、新しいエントリポイントに変更する。

```json
{
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx --watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "lint:text": "bunx textlint ./README.md",
    "lint-staged": "lint-staged",
    "prepare": "husky"
  }
}
```

削除するスクリプト: `install:all`, `build`, `clean`, `test`, `test:coverage`, `test:watch`, `lint`, `lint:fix`, `format`, `format:check`, `start:frontend`, `start:backend`

**Step 3: `Makefile` を整理**

`packages/` への参照をすべて削除する。

```makefile
.PHONY: install
install:
	bun install

.PHONY: install_ci
install_ci:
	bun install --frozen-lockfile

.PHONY: typecheck
typecheck:
	bun run typecheck

.PHONY: lint_text
lint_text:
	bun run lint:text

.PHONY: before-commit
before-commit: lint_text typecheck
```

削除するターゲット: `build`, `clean`, `test`, `test_coverage`, `test_debug`, `test_watch`, `lint`, `format`, `format_check`, `run_frontend`, `run_backend`

**Step 4: `.lintstagedrc.json` を確認・修正**

`packages/` を参照している場合は修正する。

**Step 5: コミット**

```bash
git add -A
git commit -m "refactor: テンプレート残骸を除去（packages/, contracts/）

- packages/frontend/（React テンプレート）を削除
- packages/backend/（TypeScript Express テンプレート）を削除
- contracts/（空ディレクトリ）を削除
- package.json スクリプトを整理
- Makefile を簡素化"
```

---

### Task 2: TypeScript + Hono プロジェクトセットアップ

TypeScript 設定と Hono 依存パッケージをインストールする。

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json` (dependencies)

**Step 1: 依存パッケージを追加**

```bash
bun add hono @hono/node-server
bun add -D tsx typescript @types/better-sqlite3 @types/uuid
```

Express を削除:
```bash
bun remove express
```

**Step 2: `tsconfig.json` を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: 型チェックが通ることを確認**

```bash
bun run typecheck
```

Expected: エラーなし（まだ src/ に TS ファイルがないため）

**Step 4: コミット**

```bash
git add tsconfig.json package.json bun.lock
git commit -m "chore: TypeScript + Hono プロジェクトセットアップ

- hono, @hono/node-server を追加
- express を削除
- tsx, typescript, 型定義を devDependencies に追加
- tsconfig.json を作成"
```

---

### Task 3: データベースモジュール（`src/db.ts`）

SQLite の初期化・マイグレーションを独立モジュールとして切り出す。

**Files:**
- Create: `src/db.ts`

**Step 1: `src/db.ts` を作成**

`src/server.js` の行 1-64 のデータベース初期化ロジックを TypeScript に移行する。

```typescript
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', 'data', 'deepform.db');

const db = new Database(DB_PATH);
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
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    campaign_id TEXT
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
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    owner_session_id TEXT,
    share_token TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_session_id) REFERENCES sessions(id)
  );
`);

// Migration: ensure indexes exist
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token)'); } catch { /* already exists */ }

export { db };
```

**Step 2: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 3: コミット**

```bash
git add src/db.ts
git commit -m "refactor: データベースモジュールを切り出し（src/db.ts）"
```

---

### Task 4: 型定義（`src/types.ts`）

データモデルの TypeScript 型定義を作成する。

**Files:**
- Create: `src/types.ts`

**Step 1: `src/types.ts` を作成**

```typescript
export interface Session {
  id: string;
  theme: string;
  status: 'interviewing' | 'analyzed' | 'respondent_done' | 'hypothesized' | 'prd_generated' | 'spec_generated';
  mode: 'self' | 'shared' | 'campaign_respondent';
  share_token: string | null;
  respondent_name: string | null;
  respondent_feedback: string | null;
  created_at: string;
  updated_at: string;
  campaign_id: string | null;
  user_id?: string | null;
  is_public?: number;
}

export interface Message {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface AnalysisResult {
  id: number;
  session_id: string;
  type: 'facts' | 'hypotheses' | 'prd' | 'spec';
  data: string;
  created_at: string;
}

export interface Campaign {
  id: string;
  theme: string;
  owner_session_id: string | null;
  share_token: string;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  github_id: number;
  github_login: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Fact {
  id: string;
  type: 'fact' | 'pain' | 'frequency' | 'workaround';
  content: string;
  evidence: string;
  severity: 'high' | 'medium' | 'low';
}

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  supportingFacts: string[];
  counterEvidence: string;
  unverifiedPoints: string[];
}
```

**Step 2: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 3: コミット**

```bash
git add src/types.ts
git commit -m "refactor: 型定義を追加（src/types.ts）"
```

---

### Task 5: LLM クライアント（`src/llm.ts`）

LLM Gateway 呼び出しロジックを独立モジュールに切り出す。

**Files:**
- Create: `src/llm.ts`

**Step 1: `src/llm.ts` を作成**

`src/server.js` の行 70-124（`callClaude`, `extractText`）を TypeScript に移行する。

```typescript
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
```

**Step 2: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 3: コミット**

```bash
git add src/llm.ts
git commit -m "refactor: LLM クライアントを切り出し（src/llm.ts）"
```

---

### Task 6: セッションルート（`src/routes/sessions.ts`）

セッション CRUD + AI 分析エンドポイントを Hono ルートとして実装する。

**Files:**
- Create: `src/routes/sessions.ts`

**Step 1: `src/routes/sessions.ts` を作成**

`src/server.js` の行 126-1175 のすべてのセッション・共有・キャンペーン API ルートを Hono の `app.route()` として移行する。

主な変更点:
- `express.Request/Response` → Hono の `Context`
- `req.params.id` → `c.req.param('id')`
- `req.body` → `await c.req.json()`
- `res.json(data)` → `c.json(data)`
- `res.status(400).json(err)` → `c.json(err, 400)`

`src/server.js` の全ルートをそのままの振る舞いで移行する。コードは長いが、変換は機械的。

PRD マークダウン生成関数（`generatePRDMarkdown`、行 616-661）もこのファイルに含める。

**Step 2: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 3: コミット**

```bash
git add src/routes/sessions.ts
git commit -m "refactor: セッションルートを Hono に移行（src/routes/sessions.ts）"
```

---

### Task 7: アプリケーション本体 + エントリポイント

Hono アプリの設定とサーバー起動を実装する。

**Files:**
- Create: `src/app.ts`
- Create: `src/index.ts`

**Step 1: `src/app.ts` を作成**

```typescript
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { sessionRoutes } from './routes/sessions.js';

const app = new Hono();

// API ルート
app.route('/api', sessionRoutes);

// 静的ファイル配信
app.use('/*', serveStatic({ root: './public' }));

// SPA フォールバック
app.get('/*', serveStatic({ root: './public', path: 'index.html' }));

export { app };
```

**Step 2: `src/index.ts` を作成**

```typescript
import { serve } from '@hono/node-server';
import { app } from './app.js';

const PORT = 8000;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`DeepForm server running on http://localhost:${info.port}`);
});
```

**Step 3: 旧サーバーファイルを削除**

```bash
git rm src/server.js
```

**Step 4: 動作確認**

```bash
bun run dev
```

ブラウザで `http://localhost:8000` にアクセスし、ランディングページが表示されることを確認する。

**Step 5: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 6: コミット**

```bash
git add src/app.ts src/index.ts
git commit -m "refactor: Hono + TypeScript に完全移行

- src/app.ts（Hono アプリ設定）を作成
- src/index.ts（エントリポイント）を作成
- src/server.js（旧 Express サーバー）を削除
- 全 API エンドポイントの動作を維持"
```

---

### Task 8: GitHub OAuth 認証 — データベース拡張

認証に必要なテーブルとカラムを追加する。

**Files:**
- Modify: `src/db.ts`

**Step 1: `src/db.ts` にユーザーテーブルとカラム追加**

`users` テーブルの CREATE と、`sessions` テーブルへの `user_id`, `is_public` カラム追加マイグレーションを追加する。

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  github_login TEXT NOT NULL,
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

マイグレーション:
```typescript
try { db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN is_public INTEGER DEFAULT 0'); } catch { /* already exists */ }
```

**Step 2: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 3: コミット**

```bash
git add src/db.ts
git commit -m "feat: ユーザーテーブル追加、セッションに user_id/is_public カラム追加"
```

---

### Task 9: 認証ミドルウェア（`src/middleware/auth.ts`）

署名付き Cookie によるセッション管理ミドルウェアを実装する。

**Files:**
- Create: `src/middleware/auth.ts`

**Step 1: `src/middleware/auth.ts` を作成**

```typescript
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import { db } from '../db.js';
import type { User } from '../types.js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const COOKIE_NAME = 'deepform_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sign(value: string): string {
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${signature}`;
}

function unsign(signed: string): string | null {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot === -1) return null;
  const value = signed.substring(0, lastDot);
  const expected = sign(value);
  if (signed !== expected) return null;
  return value;
}

export function setSessionCookie(c: any, userId: string): void {
  const expiry = Date.now() + MAX_AGE * 1000;
  const payload = JSON.stringify({ userId, expiry });
  setCookie(c, COOKIE_NAME, sign(payload), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: MAX_AGE,
    path: '/',
  });
}

export function clearSessionCookie(c: any): void {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

// Middleware: 認証情報を Context に設定（認証必須ではない）
export const authMiddleware = createMiddleware<{
  Variables: { user: User | null };
}>(async (c, next) => {
  const cookie = getCookie(c, COOKIE_NAME);
  if (!cookie) {
    c.set('user', null);
    return next();
  }

  const payload = unsign(cookie);
  if (!payload) {
    c.set('user', null);
    return next();
  }

  try {
    const { userId, expiry } = JSON.parse(payload) as { userId: string; expiry: number };
    if (Date.now() > expiry) {
      c.set('user', null);
      return next();
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
    c.set('user', user ?? null);
  } catch {
    c.set('user', null);
  }

  return next();
});

// Middleware: 認証必須
export const requireAuth = createMiddleware<{
  Variables: { user: User };
}>(async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'ログインが必要です' }, 401);
  }
  return next();
});
```

**Step 2: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 3: コミット**

```bash
git add src/middleware/auth.ts
git commit -m "feat: 認証ミドルウェア実装（署名付き Cookie）"
```

---

### Task 10: GitHub OAuth ルート（`src/routes/auth.ts`）

GitHub OAuth フローのエンドポイントを実装する。

**Files:**
- Create: `src/routes/auth.ts`

**Step 1: 依存パッケージ追加**

```bash
bun add @hono/oauth-providers
```

**Step 2: `src/routes/auth.ts` を作成**

`@hono/oauth-providers` の GitHub プロバイダーを使用する。コールバックでユーザーを `users` テーブルに upsert し、署名付き Cookie を発行する。

エンドポイント:
- `GET /api/auth/github` — GitHub にリダイレクト
- `GET /api/auth/github/callback` — コールバック処理
- `GET /api/auth/me` — 現在のユーザー情報
- `POST /api/auth/logout` — ログアウト

**Step 3: `src/app.ts` に認証ルートを追加**

```typescript
import { authRoutes } from './routes/auth.js';
import { authMiddleware } from './middleware/auth.js';

// 全リクエストに認証ミドルウェアを適用
app.use('*', authMiddleware);

// 認証ルート
app.route('/api/auth', authRoutes);
```

**Step 4: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 5: コミット**

```bash
git add src/routes/auth.ts src/app.ts package.json bun.lock
git commit -m "feat: GitHub OAuth ルート実装（@hono/oauth-providers）"
```

---

### Task 11: セッションルートにアクセス制御を追加

既存のセッション API にユーザー紐づけと公開/非公開制御を追加する。

**Files:**
- Modify: `src/routes/sessions.ts`

**Step 1: セッション作成時に `user_id` を設定**

`POST /api/sessions` で、ログインユーザーの `user_id` をセッションに紐づける。未ログインの場合は 401 を返す。

**Step 2: セッション一覧にフィルタリング追加**

`GET /api/sessions`:
- ログイン済み: 自分のセッション + 公開セッション
- 未ログイン: 公開セッションのみ

**Step 3: セッション詳細にアクセス制御追加**

`GET /api/sessions/:id`:
- オーナー: 常にアクセス可能
- 公開セッション: 誰でもアクセス可能
- `share_token` 経由: 既存の動作を維持
- それ以外: 403

**Step 4: 公開/非公開トグル API を追加**

`PATCH /api/sessions/:id/visibility`:
- オーナーのみ `is_public` を切り替え可能

**Step 5: 型チェック**

```bash
bun run typecheck
```

Expected: PASS

**Step 6: コミット**

```bash
git add src/routes/sessions.ts
git commit -m "feat: セッションにアクセス制御を追加（user_id 紐づけ、公開/非公開）"
```

---

### Task 12: フロントエンドに認証 UI を追加

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/i18n.js`

**Step 1: ヘッダーに認証ボタンを追加**

`public/index.html` のヘッダーに:
- 未ログイン時: 「GitHub でログイン」ボタン
- ログイン時: ユーザーアバター + ユーザー名 + ログアウトボタン

**Step 2: `public/app.js` に認証ロジックを追加**

- ページ読み込み時に `GET /api/auth/me` を呼んでログイン状態を確認
- ログイン状態に応じて UI を切り替え
- セッション作成ボタンの表示/非表示制御

**Step 3: セッション一覧に公開/非公開トグルを追加**

- セッションカードに公開/非公開アイコン + トグルボタン
- `PATCH /api/sessions/:id/visibility` を呼ぶ

**Step 4: `public/i18n.js` に認証関連の翻訳キーを追加**

**Step 5: `public/style.css` に認証 UI のスタイルを追加**

**Step 6: 動作確認**

ブラウザで以下を確認:
- 未ログイン時にログインボタンが表示される
- ログインボタンを押すと GitHub にリダイレクトされる
- ログイン後にアバター + ユーザー名が表示される
- セッション作成ができる
- 公開/非公開の切り替えができる

**Step 7: コミット**

```bash
git add public/index.html public/app.js public/style.css public/i18n.js
git commit -m "feat: フロントエンドに GitHub 認証 UI を追加

- ヘッダーにログイン/ログアウトボタン
- セッション一覧に公開/非公開トグル
- 認証状態に応じた UI 切り替え
- i18n 翻訳キー追加"
```

---

### Task 13: CI 修正

GitHub Actions の CI パイプラインを新しい構成に合わせて修正する。

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: CI ワークフローを修正**

`make before-commit` が `lint_text typecheck` を実行するように変更済みなので、CI が通ることを確認する。

**Step 2: コミット**

```bash
git add .github/workflows/ci.yml
git commit -m "fix: CI パイプラインを新しい構成に合わせて修正"
```

---

### Task 14: 最終動作確認

**Step 1: 全体の動作確認**

```bash
bun run typecheck
bun run dev
```

**Step 2: 以下のシナリオを手動テスト**

1. ランディングページが表示される
2. GitHub ログインが動作する
3. ログイン後にセッション作成ができる
4. インタビュー → ファクト抽出 → 仮説 → PRD → Spec の全フローが動作する
5. 共有リンクが動作する
6. 公開/非公開の切り替えが動作する
7. ログアウトが動作する
