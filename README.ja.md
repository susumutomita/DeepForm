<div align="center">

<img src="https://img.shields.io/badge/AI-デプスインタビュー-81a2be?style=for-the-badge" alt="AI Depth Interview">
<img src="https://img.shields.io/badge/spec.json-エクスポート-8c9440?style=for-the-badge" alt="spec.json Export">
<img src="https://img.shields.io/badge/exe.dev-Powered-de935f?style=for-the-badge" alt="exe.dev Powered">

# DeepForm

**ふわっとしたアイデアから、リリースできる仕様まで。**

AI デプスインタビューで、非エンジニアが見落とす要件を引き出し、
プロダクション品質の PRD と実装仕様を生成します。

[デモ](https://deepform.exe.xyz:8000) · [English](./README.md)

</div>

---

## 課題

AI があれば PoC は数分で作れる。でもリリースにはそれ以上が必要です。

- 誰も思いつかなかったエッジケース
- セキュリティ・可用性の要件
- エンジニアが実装できる受け入れ基準
- そもそもユーザーが本当に困っているかの検証

**エンジニアでない人には「何が足りないか」すら見えない。DeepForm はそのギャップを埋めます。**

## 仕組み

```
アイデア → AI デプスインタビュー → ファクト → 仮説 → PRD → spec.json
                                                                ↓
                                                exe.dev + Shelley / Claude Code / Cursor
```

### 5 ステップ

| ステップ | 内容 | 出力 |
|--------|------|------|
| **1. AI デプスインタビュー** | 具体例・頻度・困り度・回避策を深掘り | 構造化された対話 |
| **2. ファクト抽出** | 発話エビデンス付きで事実・ペインを構造化 | エビデンス付きファクト |
| **3. 仮説生成** | 根拠・反証・未検証ポイント付き仮説 | 反証可能な仮説 |
| **4. PRD 生成** | MVP スコープの受け入れ基準付き PRD (ISO 25010) | PRD.md |
| **5. 実装仕様** | API 仕様・DB スキーマ・テストケース | spec.json |

## 差別化ポイント

- **Evidence-linked 仕様** — すべての要件がユーザーの発話にトレース可能
- **反証付き仮説** — 思い込みを防止。各仮説に反証パターンを明示
- **深掘り専用 AI** — 汎用チャットではなく、デプスインタビュー専用ロジック
- **エージェント直投入** — `spec.json` をコーディングエージェントにそのまま渡せる

## クイックスタート

### ホスティング版を使う

[deepform.exe.xyz:8000](https://deepform.exe.xyz:8000) にアクセスし、exe.dev アカウントでログイン。

### spec.json からアプリを作る

| エージェント | 方法 |
|------------|------|
| **exe.dev + Shelley** ⭐ | spec.json を貼り付け → Shelley が VM 上でビルド＆デプロイ |
| **Claude Code** | PRD.md をリポジトリに置いて `claude` |
| **Cursor** | spec.json を Composer に貼り付け |
| **その他** | spec.json は標準 JSON 形式 |

## 技術スタック

- **ランタイム**: Node.js 22+（`node:sqlite`）
- **サーバー**: [Hono](https://hono.dev) + TypeScript
- **フロントエンド**: Vite + TypeScript
- **データベース**: SQLite (WAL モード)
- **AI**: Claude API (Anthropic)
- **認証**: exe.dev プロキシヘッダー
- **ホスティング**: [exe.dev](https://exe.dev)

## ロードマップ

- [ ] **プロダクション準備チェック** — 非機能要件を対話型で確認する AI チェックリスト
- [ ] **exe.dev 深度統合** — spec.json をプリロードした「Deploy to exe.dev」ボタン
- [ ] **キャンペーン分析** — 複数ユーザーインタビューの統合インサイト
- [ ] **GitHub Issues エクスポート** — PRD をアクショナブルな Issue に変換

## ライセンス

[LICENSE](./LICENSE) を参照。

---

<div align="center">

**Built with Claude AI × [exe.dev](https://exe.dev)**

*DeepForm は [exe.dev](https://exe.dev) ショーケースプロジェクトです。AI エージェントがアイデアからプロダクションまでを exe.dev VM 上で実現する様子をお見せします。*

</div>
