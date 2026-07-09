/**
 * Default non-functional requirements for Claude Code prompt export.
 *
 * These are reasonable defaults that apply to most software projects built
 * by non-engineer users via Claude Code. Each default is visible in the
 * output and can be overridden by interview answers.
 */

export interface NFRCategory {
  id: string;
  label: string;
  defaults: NFRItem[];
}

export interface NFRItem {
  id: string;
  description: string;
  rationale: string;
}

/**
 * Returns context-aware NFR defaults. The `context` parameter allows
 * the caller to adjust defaults based on what was learned in the interview
 * (e.g., if the user mentioned "internal tool" we can relax some items).
 */
export function getNFRDefaults(context?: {
  isInternalTool?: boolean;
  handlesPersonalData?: boolean;
  hasExternalUsers?: boolean;
}): NFRCategory[] {
  const ctx = context ?? {};

  return [
    {
      id: "reliability",
      label: "信頼性 (Reliability)",
      defaults: [
        {
          id: "R-1",
          description: "ユーザー操作でクラッシュやデータ消失が起きないこと",
          rationale: "最低限の信頼性としてデータ損失を防止する",
        },
        {
          id: "R-2",
          description: "外部 API 呼び出しが失敗した場合、ユーザーにエラーメッセージを表示しリトライ可能にすること",
          rationale: "外部依存の障害をユーザーに伝え、対処手段を残す",
        },
      ],
    },
    {
      id: "error-handling",
      label: "エラーハンドリング (Error Handling)",
      defaults: [
        {
          id: "E-1",
          description:
            "すべてのフォーム送信にサーバーサイドバリデーションを実装し、不正入力時は具体的なエラーメッセージを返すこと",
          rationale: "フロントエンドバリデーションだけでは不十分。サーバー側で必ず検証する",
        },
        {
          id: "E-2",
          description: "予期しないエラー時にはスタックトレースをユーザーに見せず、汎用エラー画面を表示すること",
          rationale: "内部実装の詳細を公開しない",
        },
      ],
    },
    {
      id: "logging",
      label: "ログ・可観測性 (Logging & Observability)",
      defaults: [
        {
          id: "L-1",
          description: "エラー発生時にエラー内容・リクエスト情報・タイムスタンプをサーバーログに記録すること",
          rationale: "問題発生時に原因調査できる最低限のログ",
        },
        {
          id: "L-2",
          description: "主要な業務操作（作成・更新・削除）をログに記録すること",
          rationale: "誰がいつ何をしたか追跡できるようにする",
        },
      ],
    },
    {
      id: "security",
      label: "セキュリティ (Security)",
      defaults: [
        {
          id: "S-1",
          description: "ユーザー入力はすべてサーバーサイドでサニタイズし、SQL インジェクション・XSS を防止すること",
          rationale: "OWASP Top 10 の基本対策",
        },
        ...(ctx.handlesPersonalData
          ? [
              {
                id: "S-2",
                description: "個人情報は暗号化して保存し、アクセスログを記録すること",
                rationale: "個人データを扱うことがインタビューで判明したため",
              },
            ]
          : []),
        ...(ctx.hasExternalUsers
          ? [
              {
                id: "S-3",
                description: "認証・認可を実装し、他ユーザーのデータにアクセスできないこと",
                rationale: "外部ユーザーがいるため権限分離が必須",
              },
            ]
          : []),
        ...(!ctx.hasExternalUsers && !ctx.handlesPersonalData
          ? [
              {
                id: "S-2",
                description: "基本的な認証を実装し、API エンドポイントを保護すること",
                rationale: "内部ツールでも最低限の認証は必要",
              },
            ]
          : []),
      ],
    },
    {
      id: "usability",
      label: "使いやすさ (Usability)",
      defaults: [
        {
          id: "U-1",
          description: "主要な操作を初めてのユーザーが説明なしで完了できること",
          rationale: "非技術者が使うことを前提とした設計",
        },
        {
          id: "U-2",
          description: "処理に 1 秒以上かかる操作にはローディング表示を出すこと",
          rationale: "ユーザーに処理中であることを伝える",
        },
        {
          id: "U-3",
          description: "操作の成功・失敗をフィードバック（トースト通知など）で明示すること",
          rationale: "操作結果が分からないと不安になる",
        },
      ],
    },
    {
      id: "data-integrity",
      label: "データ整合性 (Data Integrity)",
      defaults: [
        {
          id: "D-1",
          description: "データは DB に永続化し、ページリロードで消えないこと",
          rationale: "DeepForm の基本原則: モックデータ禁止",
        },
        {
          id: "D-2",
          description: "削除操作には確認ダイアログを表示すること",
          rationale: "誤操作によるデータ損失を防止する",
        },
      ],
    },
  ];
}

/**
 * Format NFR defaults as a markdown section for prompt inclusion.
 */
export function formatNFRsAsMarkdown(categories: NFRCategory[]): string {
  const sections = categories.map((cat) => {
    const items = cat.defaults
      .map((item) => `- **${item.id}**: ${item.description}\n  - 理由: ${item.rationale}`)
      .join("\n");
    return `### ${cat.label}\n${items}`;
  });
  return `## デフォルト非機能要件\n\n以下は明示的に指定されない限り適用されるデフォルト要件です。プロジェクトの文脈に合わない場合は調整してください。\n\n${sections.join("\n\n")}`;
}
