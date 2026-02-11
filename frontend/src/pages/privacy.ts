/**
 * Privacy Policy page for DeepForm
 */
export function renderPrivacyPolicy(): string {
  return `
<article class="policy-page">
  <p class="policy-meta">最終更新日: 2026年2月</p>

  <h1>プライバシーポリシー</h1>

  <p>
    本プライバシーポリシーは、DeepForm（以下「本サービス」）における個人情報およびユーザーデータの取り扱いについて説明するものです。
    本サービスをご利用いただくことにより、本ポリシーに同意いただいたものとみなします。
  </p>

  <h2>1. 収集する情報</h2>
  <p>本サービスでは、以下の情報を収集・保持します。</p>
  <ul>
    <li><strong>認証情報:</strong> exe.dev の「Login with exe」認証システムを通じて提供されるメールアドレスおよびユーザーID（<code>X-ExeDev-UserID</code> / <code>X-ExeDev-Email</code> ヘッダー経由）</li>
    <li><strong>インタビューコンテンツ:</strong> ユーザーがインタビューセッションで入力したテキスト、およびそこから生成されたファクト・仮説・PRD・仕様書等の成果物</li>
    <li><strong>セッションデータ:</strong> インタビューセッションの作成日時、更新日時、共有設定、キャンペーン関連情報</li>
  </ul>

  <h2>2. 情報の利用目的</h2>
  <p>収集した情報は、以下の目的で利用します。</p>
  <ul>
    <li>ユーザーの認証およびセッションの識別</li>
    <li>インタビュー内容の AI 処理（Anthropic Claude API を使用した要件定義・仕様書の生成）</li>
    <li>セッション履歴の保存および表示</li>
    <li>キャンペーン機能を通じた他ユーザーとのセッション共有</li>
    <li>サービスの改善および不具合の修正</li>
  </ul>

  <h2>3. 第三者への情報提供</h2>
  <p>
    本サービスでは、インタビューコンテンツの処理のために <strong>Anthropic, PBC</strong> が提供する Claude API にデータを送信します。
    送信されるデータには、ユーザーが入力したインタビュー内容が含まれます。
    Anthropic のデータ取り扱いについては、
    <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer">Anthropic のプライバシーポリシー</a>をご参照ください。
  </p>
  <p>
    上記を除き、法令に基づく場合を除いて、ユーザーの個人情報を第三者に提供・販売することはありません。
  </p>

  <h2>4. データの保存</h2>
  <p>
    ユーザーデータは、exe.dev の仮想マシン上の SQLite データベースに保存されます。
    データは exe.dev のインフラストラクチャ上で管理されます。
  </p>

  <h2>5. データの保持期間</h2>
  <p>
    インタビューセッションおよび関連データは、ユーザーがセッションを削除するまで保持されます。
    ユーザーはいつでも自身のセッションを削除することができます。
  </p>

  <h2>6. Cookie について</h2>
  <p>
    本サービス自体は独自の Cookie を設定しません。
    認証に関する Cookie は exe.dev の認証システムによって管理されます。
    Cookie の取り扱いについては、exe.dev のプライバシーポリシーもあわせてご確認ください。
  </p>

  <h2>7. ユーザーの権利</h2>
  <p>ユーザーは以下の権利を有します。</p>
  <ul>
    <li><strong>アクセス権:</strong> 自身のインタビューセッションおよび生成された成果物にアクセスし、内容を確認する権利</li>
    <li><strong>削除権:</strong> 自身のインタビューセッションを削除し、関連データを消去する権利</li>
    <li><strong>共有の管理:</strong> セッションの共有設定を自身で管理する権利</li>
  </ul>

  <h2>8. お問い合わせ</h2>
  <p>
    本ポリシーに関するご質問やデータに関するお問い合わせは、
    <a href="https://github.com/susumutomita/DeepForm/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a>
    にてお受けしております。
  </p>

  <h2>9. ポリシーの変更</h2>
  <p>
    本ポリシーは、サービスの変更や法令の改正等に応じて、予告なく改定される場合があります。
    重要な変更がある場合は、本サービス上でお知らせします。
    改定後のポリシーは、本ページに掲載された時点で効力を生じるものとします。
  </p>
</article>
`;
}
