# DeepForm API リファレンス

ベース URL: `http://localhost:8000/api`

## 認証方式

Cookie ベースのセッション認証を使用する。`/api/auth/github` で GitHub OAuth ログインすると、署名付きセッション Cookie (`deepform_session`) が設定される。有効期限は 30 日間。

認証が必要なエンドポイントにセッション Cookie なしでアクセスすると `401` が返る。

## 共通エラーレスポンス

すべてのエンドポイントは、エラー時に以下の形式で返す。

```json
{
  "error": "エラーメッセージ"
}
```

| ステータスコード | 説明 |
|------------------|------|
| 400 | リクエスト不正 (バリデーションエラー、前提条件未達) |
| 401 | 未認証 (ログインが必要) |
| 403 | アクセス権限なし |
| 404 | リソースが見つからない |
| 500 | サーバー内部エラー |

---

## 認証 API

### GET /api/auth/github

GitHub OAuth 認証を開始する。ブラウザからアクセスすると GitHub の認可画面にリダイレクトされる。認証成功後、セッション Cookie を設定して `/` にリダイレクトする。

- 認証: 不要
- リダイレクト: GitHub OAuth 認可画面 → コールバック → `/`

### GET /api/auth/me

現在ログイン中のユーザー情報を取得する。

- 認証: 不要 (未ログイン時は `user: null`)

レスポンス (ログイン中):

```json
{
  "user": {
    "id": "uuid",
    "githubLogin": "username",
    "avatarUrl": "https://avatars.githubusercontent.com/..."
  }
}
```

レスポンス (未ログイン):

```json
{
  "user": null
}
```

### POST /api/auth/logout

ログアウトする。セッション Cookie を削除する。

- 認証: 不要

レスポンス:

```json
{
  "ok": true
}
```

---

## セッション API

### POST /api/sessions

新しいインタビューセッションを作成する。

- 認証: 必須

リクエストボディ:

```json
{
  "theme": "調査したい課題テーマ"
}
```

レスポンス (`200`):

```json
{
  "sessionId": "uuid",
  "theme": "課題テーマ"
}
```

エラー (`400`): テーマが空の場合。

### GET /api/sessions

セッション一覧を取得する。ログイン中は自分のセッションと公開セッション、未ログイン時は公開セッションのみ返す。

- 認証: 不要 (ログイン状態で結果が変わる)

レスポンス (`200`):

```json
[
  {
    "id": "uuid",
    "theme": "テーマ",
    "status": "interviewing",
    "mode": "self",
    "share_token": null,
    "respondent_name": null,
    "respondent_feedback": null,
    "created_at": "2025-01-01 00:00:00",
    "updated_at": "2025-01-01 00:00:00",
    "campaign_id": null,
    "user_id": "uuid",
    "is_public": 0,
    "message_count": 5,
    "display_status": null
  }
]
```

### GET /api/sessions/:id

セッション詳細を取得する。メッセージ履歴と分析結果を含む。

- 認証: 不要 (オーナーまたは公開セッションのみアクセス可)

レスポンス (`200`):

```json
{
  "id": "uuid",
  "theme": "テーマ",
  "status": "analyzed",
  "messages": [
    {
      "id": 1,
      "session_id": "uuid",
      "role": "assistant",
      "content": "質問テキスト",
      "created_at": "2025-01-01 00:00:00"
    }
  ],
  "analysis": {
    "facts": { "facts": [...] },
    "hypotheses": { "hypotheses": [...] },
    "prd": { "prd": {...} },
    "spec": { "spec": {...} }
  }
}
```

### DELETE /api/sessions/:id

セッションを削除する。関連するメッセージと分析結果も削除される。

- 認証: 必須 (オーナーのみ)

レスポンス (`200`):

```json
{
  "ok": true
}
```

### PATCH /api/sessions/:id/visibility

セッションの公開/非公開を切り替える。

- 認証: 必須 (オーナーのみ)

リクエストボディ:

```json
{
  "is_public": true
}
```

レスポンス (`200`): 更新後のセッションオブジェクト。

---

## インタビュー API

### POST /api/sessions/:id/start

インタビューを開始する。AI が最初の質問を生成する。

- 認証: 必須 (オーナーのみ)

レスポンス (`200`):

```json
{
  "reply": "AI からの最初の質問"
}
```

既にインタビューが開始済みの場合:

```json
{
  "reply": "インタビューは既に開始されています。",
  "alreadyStarted": true
}
```

### POST /api/sessions/:id/chat

インタビューでメッセージを送信し、AI の返答を受け取る。

- 認証: 必須 (オーナーのみ)

リクエストボディ:

```json
{
  "message": "ユーザーの回答テキスト"
}
```

レスポンス (`200`):

```json
{
  "reply": "AI の次の質問",
  "turnCount": 3,
  "readyForAnalysis": false
}
```

`readyForAnalysis` が `true` になったら、ファクト抽出 (analyze) に進める。5 ターン以上で AI が判断するか、8 ターンで自動的に `true` になる。

---

## 分析 API

### POST /api/sessions/:id/analyze

インタビュー記録からファクトを抽出する。

- 認証: 必須 (オーナーのみ)
- 前提条件: インタビューにメッセージがあること

レスポンス (`200`):

```json
{
  "facts": [
    {
      "id": "F1",
      "type": "pain",
      "content": "抽出されたファクト",
      "evidence": "元の発話の引用",
      "severity": "high"
    }
  ]
}
```

`type` の値: `fact` (事実), `pain` (困りごと), `frequency` (頻度), `workaround` (回避策)

`severity` の値: `high`, `medium`, `low`

### POST /api/sessions/:id/hypotheses

ファクトから仮説を生成する。

- 認証: 必須 (オーナーのみ)
- 前提条件: ファクト抽出 (analyze) が完了していること

リクエストボディ: なし

レスポンス (`200`):

```json
{
  "hypotheses": [
    {
      "id": "H1",
      "title": "仮説タイトル",
      "description": "仮説の詳細説明",
      "supportingFacts": ["F1", "F3"],
      "counterEvidence": "反証パターン",
      "unverifiedPoints": ["未検証ポイント"]
    }
  ]
}
```

エラー (`400`): ファクト抽出が未完了の場合。

### POST /api/sessions/:id/prd

ファクトと仮説から PRD (プロダクト要件定義書) を生成する。

- 認証: 必須 (オーナーのみ)
- 前提条件: ファクト抽出と仮説生成が完了していること

リクエストボディ: なし

レスポンス (`200`):

```json
{
  "prd": {
    "problemDefinition": "問題定義",
    "targetUser": "対象ユーザー",
    "jobsToBeDone": ["ジョブ1"],
    "coreFeatures": [
      {
        "name": "機能名",
        "description": "説明",
        "priority": "must",
        "acceptanceCriteria": ["基準1"],
        "edgeCases": ["エッジケース1"]
      }
    ],
    "nonGoals": ["やらないこと"],
    "userFlows": [
      {
        "name": "フロー名",
        "steps": ["ステップ1"]
      }
    ],
    "qualityRequirements": {
      "functionalSuitability": {
        "description": "要件説明",
        "criteria": ["基準1"]
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
```

エラー (`400`): ファクト抽出または仮説生成が未完了の場合。

### POST /api/sessions/:id/spec

PRD から実装仕様 (spec.json) を生成する。

- 認証: 必須 (オーナーのみ)
- 前提条件: PRD 生成が完了していること

リクエストボディ: なし

レスポンス (`200`):

```json
{
  "spec": {
    "projectName": "プロジェクト名",
    "techStack": {
      "frontend": "技術",
      "backend": "技術",
      "database": "DB"
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
        "description": "説明"
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
  },
  "prdMarkdown": "# PRD: テーマ\n..."
}
```

エラー (`400`): PRD 生成が未完了の場合。

---

## 共有 API

セッションオーナーが共有トークンを発行し、第三者がインタビューに回答できる。認証不要。

### POST /api/sessions/:id/share

共有トークンを生成する。既にトークンがある場合はそのトークンを返す。

- 認証: 必須 (オーナーのみ)

リクエストボディ: なし

レスポンス (`200`):

```json
{
  "shareToken": "a1b2c3d4",
  "theme": "テーマ"
}
```

### GET /api/shared/:token

共有セッションの情報を取得する。

- 認証: 不要

レスポンス (`200`):

```json
{
  "theme": "テーマ",
  "status": "interviewing",
  "respondentName": null,
  "messageCount": 0,
  "facts": null
}
```

### POST /api/shared/:token/start

共有インタビューを開始する。AI が最初の質問を生成する。

- 認証: 不要

リクエストボディ:

```json
{
  "respondentName": "回答者名 (任意)"
}
```

レスポンス (`200`):

```json
{
  "reply": "AI からの最初の質問"
}
```

既に開始済みの場合は過去のメッセージを含む:

```json
{
  "reply": "最初の質問",
  "alreadyStarted": true,
  "messages": [...]
}
```

### POST /api/shared/:token/chat

共有インタビューでメッセージを送信する。

- 認証: 不要

リクエストボディ:

```json
{
  "message": "回答テキスト"
}
```

レスポンス (`200`):

```json
{
  "reply": "AI の次の質問",
  "turnCount": 3,
  "isComplete": false
}
```

エラー (`400`): インタビューが既に完了している場合。

### POST /api/shared/:token/complete

共有インタビューを完了し、ファクトを自動抽出する。

- 認証: 不要

リクエストボディ: なし

レスポンス (`200`): ファクトオブジェクト (`analyze` と同じ形式)。

### POST /api/shared/:token/feedback

回答者がフィードバックを送信する。

- 認証: 不要

リクエストボディ:

```json
{
  "feedback": "フィードバックテキスト"
}
```

レスポンス (`200`):

```json
{
  "ok": true
}
```

---

## キャンペーン API

セッションからキャンペーンを作成し、複数の回答者からインタビューを収集して集約分析する。

### POST /api/sessions/:id/campaign

セッションからキャンペーンを作成する。既にキャンペーンがある場合はそのキャンペーン情報を返す。

- 認証: 必須 (セッションオーナーのみ)

リクエストボディ: なし

レスポンス (`201`):

```json
{
  "campaignId": "uuid",
  "shareToken": "a1b2c3d4",
  "theme": "テーマ"
}
```

### GET /api/campaigns/:token

キャンペーン情報と回答者一覧を取得する。

- 認証: 不要

レスポンス (`200`):

```json
{
  "campaignId": "uuid",
  "theme": "テーマ",
  "shareToken": "a1b2c3d4",
  "ownerSessionId": "uuid",
  "respondentCount": 3,
  "respondents": [
    {
      "id": "uuid",
      "respondent_name": "回答者名",
      "status": "respondent_done",
      "created_at": "2025-01-01 00:00:00",
      "message_count": 6
    }
  ],
  "createdAt": "2025-01-01 00:00:00"
}
```

### POST /api/campaigns/:token/join

キャンペーンに参加し、新しい回答者セッションを作成する。AI が最初の質問を生成する。

- 認証: 不要

リクエストボディ:

```json
{
  "respondentName": "回答者名 (任意)"
}
```

レスポンス (`201`):

```json
{
  "sessionId": "uuid",
  "reply": "AI からの最初の質問",
  "theme": "テーマ"
}
```

### POST /api/campaigns/:token/sessions/:sessionId/chat

キャンペーンのインタビューでメッセージを送信する。

- 認証: 不要

リクエストボディ:

```json
{
  "message": "回答テキスト"
}
```

レスポンス (`200`):

```json
{
  "reply": "AI の次の質問",
  "turnCount": 3,
  "isComplete": false
}
```

エラー (`400`): インタビューが既に完了している場合。

### POST /api/campaigns/:token/sessions/:sessionId/complete

キャンペーンのインタビューを完了し、ファクトを自動抽出する。

- 認証: 不要

リクエストボディ: なし

レスポンス (`200`): ファクトオブジェクト (`analyze` と同じ形式)。

### POST /api/campaigns/:token/sessions/:sessionId/feedback

キャンペーン回答者がフィードバックを送信する。

- 認証: 不要

リクエストボディ:

```json
{
  "feedback": "フィードバックテキスト"
}
```

レスポンス (`200`):

```json
{
  "ok": true
}
```

### GET /api/campaigns/:token/aggregate

キャンペーンの全回答者のファクトを集約する。完了済み (`respondent_done`) のセッションのみ対象。

- 認証: 不要

レスポンス (`200`):

```json
{
  "campaignId": "uuid",
  "theme": "テーマ",
  "totalRespondents": 3,
  "totalFacts": 25,
  "respondents": [
    {
      "sessionId": "uuid",
      "name": "回答者名",
      "factCount": 8,
      "feedback": "フィードバックテキスト"
    }
  ],
  "allFacts": [
    {
      "id": "F1",
      "type": "pain",
      "content": "ファクト内容",
      "evidence": "発話の引用",
      "severity": "high",
      "respondent": "回答者名",
      "sessionId": "uuid"
    }
  ]
}
```

---

## データベーススキーマ

### users

| カラム | 型 | 説明 |
|--------|------|------|
| id | TEXT (PK) | UUID |
| github_id | INTEGER (UNIQUE) | GitHub ユーザー ID |
| github_login | TEXT | GitHub ユーザー名 |
| avatar_url | TEXT | アバター URL |
| created_at | DATETIME | 作成日時 |
| updated_at | DATETIME | 更新日時 |

### sessions

| カラム | 型 | 説明 |
|--------|------|------|
| id | TEXT (PK) | UUID |
| theme | TEXT | インタビューテーマ |
| status | TEXT | ステータス (interviewing, analyzed, hypothesized, prd_generated, spec_generated, respondent_done) |
| mode | TEXT | モード (self, shared, campaign_respondent) |
| share_token | TEXT (UNIQUE) | 共有トークン |
| respondent_name | TEXT | 回答者名 |
| respondent_feedback | TEXT | 回答者フィードバック |
| campaign_id | TEXT | キャンペーン ID (FK) |
| user_id | TEXT | ユーザー ID (FK) |
| is_public | INTEGER | 公開フラグ (0/1) |
| created_at | DATETIME | 作成日時 |
| updated_at | DATETIME | 更新日時 |

### messages

| カラム | 型 | 説明 |
|--------|------|------|
| id | INTEGER (PK) | 自動採番 |
| session_id | TEXT (FK) | セッション ID |
| role | TEXT | 発言者 (user, assistant) |
| content | TEXT | メッセージ内容 |
| created_at | DATETIME | 作成日時 |

### analysis_results

| カラム | 型 | 説明 |
|--------|------|------|
| id | INTEGER (PK) | 自動採番 |
| session_id | TEXT (FK) | セッション ID |
| type | TEXT | 分析種別 (facts, hypotheses, prd, spec) |
| data | TEXT | JSON 形式の分析データ |
| created_at | DATETIME | 作成日時 |

### campaigns

| カラム | 型 | 説明 |
|--------|------|------|
| id | TEXT (PK) | UUID |
| theme | TEXT | キャンペーンテーマ |
| owner_session_id | TEXT (FK) | 元セッション ID |
| share_token | TEXT (UNIQUE) | 共有トークン |
| created_at | DATETIME | 作成日時 |
| updated_at | DATETIME | 更新日時 |
