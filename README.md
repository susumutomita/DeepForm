# DeepForm

AI デプスインタビューから実装仕様まで自動生成するツール。

## 概要

ふわっとした課題テーマを入力するだけで、AI がデプスインタビューを実施し、ファクト抽出、仮説生成、PRD、実装仕様 (spec.json) まで自動生成する。

### 主要フロー

1. テーマを入力してインタビューセッションを作成
2. AI がデプスインタビューを実施 (5-8 ターン)
3. インタビュー記録からファクト (事実・課題・頻度・回避策) を抽出
4. ファクトから仮説を生成
5. 仮説から PRD (プロダクト要件定義書) を生成
6. PRD からコーディングエージェント向けの実装仕様 (spec.json) を生成

### キャンペーンモード

共有リンクを使って不特定多数からインタビュー回答を収集し、ファクトを集約分析できる。

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| バックエンド | Hono (TypeScript) |
| データベース | SQLite (`node:sqlite`, WAL モード) |
| フロントエンド | Vanilla JS SPA |
| 認証 | GitHub OAuth (@hono/oauth-providers) |
| LLM | Claude API (LLM Gateway 経由) |
| バリデーション | Zod |
| テスト | Vitest |
| リンター | Biome |

## セットアップ

### 前提条件

- Node.js 24 以上 (`node:sqlite` を使用)
- bun (パッケージマネージャー)
- GitHub OAuth App (認証機能を使う場合)

### インストール

```bash
make install
```

### 環境変数

`.env` ファイルをプロジェクトルートに作成し、以下の変数を設定する。

| 変数名 | 説明 | 必須 |
|--------|------|------|
| GITHUB_CLIENT_ID | GitHub OAuth App の Client ID | はい |
| GITHUB_CLIENT_SECRET | GitHub OAuth App の Client Secret | はい |
| SESSION_SECRET | セッション Cookie の署名に使う秘密鍵 | はい (本番環境) |
| NODE_ENV | 実行環境 (production で Secure Cookie が有効) | いいえ |

LLM 呼び出しは LLM Gateway (`http://169.254.169.254/gateway/llm/anthropic/v1/messages`) 経由で行うため、Anthropic API キーは不要。

### 起動

```bash
# 開発サーバー (ホットリロード)
make dev

# 本番起動
make start
```

サーバーは `http://localhost:8000` で起動する。

## 開発コマンド

| コマンド | 説明 |
|----------|------|
| `make start` | 依存インストール + 本番サーバー起動 |
| `make dev` | 依存インストール + 開発サーバー起動 (ホットリロード) |
| `make lint` | Biome によるリントチェック |
| `make lint_text` | textlint による日本語テキストチェック |
| `make typecheck` | 型チェック (tsc --noEmit) |
| `make test` | Vitest でテスト実行 |
| `make before-commit` | 全品質チェック (lint + lint_text + typecheck + test) |

## アーキテクチャ

```text
src/
  index.ts          # エントリポイント (Hono サーバー起動)
  app.ts            # Hono アプリケーション設定 (ルーティング、ミドルウェア)
  db.ts             # SQLite データベース接続、スキーマ定義 (`node:sqlite`)
  llm.ts            # LLM Gateway クライアント (Claude API)
  types.ts          # TypeScript 型定義
  routes/
    auth.ts         # 認証 API (GitHub OAuth、ログアウト)
    sessions.ts     # セッション CRUD、インタビュー、分析、共有、キャンペーン
  middleware/
    auth.ts         # 認証ミドルウェア (Cookie ベースセッション管理)
public/             # フロントエンド静的ファイル (Vanilla JS SPA)
data/               # SQLite データベースファイル
```

### データモデル

- **users** - GitHub OAuth で認証されたユーザー
- **sessions** - インタビューセッション (テーマ、ステータス、モード)
- **messages** - インタビューの会話履歴 (user/assistant)
- **analysis_results** - 分析結果 (facts/hypotheses/prd/spec)
- **campaigns** - キャンペーン (複数回答者からの集約)

### セッションのステータス遷移

```text
interviewing → analyzed → hypothesized → prd_generated → spec_generated
```

共有/キャンペーンの回答者は `respondent_done` に遷移する。

## API ドキュメント

API の詳細な仕様は [docs/api.md](docs/api.md) を参照。

## ライセンス

ISC
