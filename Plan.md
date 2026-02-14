# Development Plan

## プロダクション品質への昇華 - 2026-02-11

### 目的 (Objective)

DeepForm をプロダクションレディな品質に引き上げる。テスト、デザイン、品質に特に注力する。

### 現状分析 (Current State)

- **テスト**: ゼロ。テストフレームワーク未導入
- **lint (コード)**: 未導入
- **build スクリプト**: なし
- **入力バリデーション**: サーバーサイドバリデーションなし
- **フロントエンド**: Vanilla JS SPA、型安全性なし
- **アクセシビリティ**: 未考慮
- **エラーハンドリング**: console.error のみ
- **レート制限**: なし
- **既知バグ**: `appendChatBubble` 未定義関数の呼び出し

### チーム構成

| 役割 | 担当領域 |
|------|----------|
| PO | バックログ優先順位、受け入れ基準定義 |
| Developer | テスト基盤、バグ修正、コード品質、バリデーション |
| Designer | UI/UX 改善、アクセシビリティ、レスポンシブ |
| QA | テスト作成、バグ発見、品質保証 |
| Tech Writer | ドキュメント改善、API ドキュメント |
| User | ユーザビリティ検証、UX フィードバック |

### フェーズ 1: 基盤整備 (Infrastructure)

- [x] テストフレームワーク導入 (Vitest)
- [x] ESLint / Biome 導入
- [x] build スクリプト追加
- [x] package.json スクリプト整備

### フェーズ 2: 品質改善 (Quality)

- [x] Zod によるサーバーサイドバリデーション追加
- [x] 既知バグ修正 (appendChatBubble 等)
- [x] エラーハンドリング改善
- [x] セキュリティ強化 (SESSION_SECRET 検証、トークンエントロピー改善、LLM タイムアウト)

### フェーズ 3: テスト (Testing)

- [x] バックエンド API ユニットテスト
- [x] ミドルウェアテスト
- [x] LLM モジュールテスト
- [ ] フロントエンド E2E テスト

### フェーズ 4: デザイン (Design)

- [x] アクセシビリティ改善 (ARIA、キーボードナビゲーション)
- [x] ダークモード対応
- [x] モバイルレスポンシブ改善
- [x] ローディング/エラー状態の UX 改善

### フェーズ 5: ドキュメント (Documentation)

- [x] API ドキュメント
- [x] 開発者向けセットアップガイド
- [x] アーキテクチャ図

### 進捗ログ (Progress Log)

- [2026-02-11] 現状分析完了、チーム編成開始
- [2026-02-11] フェーズ 1-5 実装完了 (E2E テスト除く)。62 テスト合格、lint/typecheck 通過
- [2026-02-11] CodeRabbit レビュー対応: セキュリティ強化、i18n 修正、エラーハンドリング改善

- [2026-02-11] ポリッシュラウンド 2 完了:
  - ダークモード切替、ポリシーモーダル、README.ja.md
  - セッション数制限（MAX_SESSIONS_PER_USER=50、429 エラー）
  - BDD テスト 103 件（全エンドポイント網羅）
  - Makefile を bun → npm/npx に移行
  - biome format 適用

---

## sessions.ts リファクタリング — 2026-02-13

### 目的 (Objective)

- 1,672 行のモノリシック sessions.ts を機能別モジュールに分割し保守性を向上させる
- コード重複を排除し Single Source of Truth を確立する
- 型安全性を向上させ `as unknown as Type` キャストを削減する
- 全 152 テストを維持しながらリファクタリングする（リグレッション禁止）

### 制約 (Guardrails)

- テストファイルの変更は最小限（import パスの変更のみ）
- 外部 API・DB スキーマは変更しない
- app.ts の route 登録は互換性を保つ
- 段階的に実施し、各ステップでテストが通ることを確認する

### 現状分析

#### ファイルサイズ分布（バックエンド src/ 配下）

| ファイル | 行数 | 割合 |
|---------|------|------|
| routes/sessions.ts | 1,672 | 53% |
| routes/prd-edit.ts | 300 | 10% |
| llm.ts | 282 | 9% |
| routes/auth.ts | 219 | 7% |
| db.ts | 171 | 5% |
| routes/analytics.ts | 107 | 3% |
| types.ts | 84 | 3% |
| routes/feedback.ts | 69 | 2% |
| app.ts | 65 | 2% |
| validation.ts | 27 | 1% |
| 合計 | ~3,100 | 100% |

#### sessions.ts の機能ドメイン分析

| ドメイン | 行範囲 | 行数 | 内容 |
|---------|--------|------|------|
| ヘルパー関数 | 1-100 | 100 | formatZodError, getOwnedSession, isResponse, generatePRDMarkdown |
| Session CRUD | 102-235 | 134 | POST/GET/DELETE/PATCH sessions |
| Interview Flow | 237-421 | 185 | start, chat (SSE streaming 含む) |
| Analysis Pipeline | 424-963 | 540 | analyze, hypotheses, prd, spec, readiness, spec-export |
| Campaign CRUD | 1000-1303 | 304 | create, get, join, chat, complete, feedback |
| Campaign Analytics | 1305-1670 | 366 | helpers, analytics, generate, export, aggregate |

#### 重複コード

1. **`getOwnedSession()`**: sessions.ts:31-40 と prd-edit.ts:35-43 に重複（ロジック同一、404 メッセージのみ差異）
2. **`isResponse()`**: sessions.ts:42-44 と prd-edit.ts:46-48 に重複（完全同一）
3. **`formatZodError()`**: sessions.ts:22-24 と feedback.ts:61-62（同等ロジック）
4. **`AppEnv` 型定義**: sessions.ts, prd-edit.ts, analytics.ts, feedback.ts の4箇所で重複
5. **分析結果 upsert パターン**: sessions.ts 内で7回繰り返し（analyze, hypotheses, prd, spec, readiness, campaign complete, campaign analytics generate）
6. **LLM 呼び出し + JSON パース + フォールバック**: sessions.ts 内で7回繰り返し

#### その他の課題

- ハードコード管理者メール: analytics.ts:7 `const ADMIN_EMAILS = ["oyster880@gmail.com"]`
- `as unknown as Type` キャスト: sessions.ts に 30+ 箇所、prd-edit.ts に 3 箇所、auth.ts に 5 箇所
- エラーメッセージ日英混在: 日本語（"ログインが必要です"）と英語（"Session not found"）が混在

### Phase 1: 共通ユーティリティの抽出（Task #3）

リスク: 低（ヘルパー関数の移動のみ、ロジック変更なし）

#### 1-1. `AppEnv` 型を types.ts に追加

各ファイル（sessions.ts, prd-edit.ts, analytics.ts, feedback.ts）のローカル定義を import に置換する。

#### 1-2. `src/helpers/session-ownership.ts` を作成

sessions.ts と prd-edit.ts から重複する以下を抽出する。

- `getOwnedSession()` — セッションオーナーシップチェック
- `isResponse()` — Response 型ガード
- `getOwnedCampaignById()` — キャンペーンオーナーシップチェック（sessions.ts から移動）

#### 1-3. `src/helpers/format.ts` を作成

- `formatZodError()` — Zod エラーフォーマット
- `generatePRDMarkdown()` — PRD マークダウン生成

#### 1-4. `src/helpers/analysis-store.ts` を作成

7回繰り返される分析結果 upsert パターンを共通関数化する。

### Phase 2: sessions.ts のモジュール分割（Task #2）

リスク: 中（ファイル構造変更、import パス変更あり）

#### ディレクトリ構造

```
src/routes/sessions/
  index.ts              — sessionRoutes を re-export（app.ts 互換性維持）
  crud.ts               — Session CRUD (create, list, get, delete, visibility)
  interview.ts          — Interview flow (start, chat + SSE streaming)
  analysis.ts           — Analysis pipeline (analyze 〜 readiness, spec-export)
  campaigns.ts          — Campaign 全エンドポイント（CRUD + respondent + analytics）
```

app.ts の import を `"./routes/sessions/index.ts"` に明示的に変更する。テストファイルは app.ts 経由の統合テストのため変更不要。

### Phase 3: 型安全性の強化（Task #4）

リスク: 低〜中

- ハードコード管理者メールの環境変数化
- エラーメッセージの日本語統一（"Session not found" → "セッションが見つかりません" 等）
- `as unknown as Type` キャストは node:sqlite の制約であり、ヘルパー関数への集約で対応

### タスク (TODOs)

- [x] コードベース分析完了
- [x] リファクタリング計画策定
- [ ] Phase 1: 共通ユーティリティの抽出（Task #3）
- [ ] Phase 2: sessions.ts のモジュール分割（Task #2）
- [ ] Phase 3: 型安全性の強化（Task #4）
- [ ] Phase 4: 最終検証（Task #5）

### 検証手順 (Validation)

- 各 Phase 完了後に `bun run test` を実行し 152 テスト全通過を確認
- `bun run lint` でリント通過を確認
- `bun run typecheck` で型チェック通過を確認
- `make before-commit` で全検証通過を確認

### 未解決の質問 (Open Questions)

- campaigns.ts が 670 行になるため、さらに campaigns-crud.ts と campaign-analytics.ts に分割すべきか（現時点では1ファイルで進め、必要に応じて後で分割）
- prd-edit.ts の getOwnedSession の 404 エラーメッセージが sessions.ts 版と異なる（"セッションが見つかりません" vs "Session not found"）。共通化時に日本語に統一する

### 進捗ログ (Progress Log)

- [2026-02-13 17:44] コードベース分析完了。sessions.ts の6ドメイン、重複6箇所、キャスト 30+ 箇所を特定
- [2026-02-13 17:45] テストベースライン確認: 8 ファイル 152 テスト全通過 (338ms)
- [2026-02-13 17:50] リファクタリング計画策定完了。Phase 1-4 の段階的実行計画を作成
