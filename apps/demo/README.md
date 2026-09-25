# Jev Switchboard

React / Vite の静的ビューア。公開パスは `/jev-playwright-repair-lab/`。
ビルド時に `data/public/results.json` を読み、core の `PublicDataset` / `TrialResult` と同じ契約をランタイムでも検証する。
不正形式・未承認の非空データはエラーとして表示し、空データへフォールバックしない。

- 主役は「有限な判断をGPTからJevへ差し替える」体験。全件テーブルを最初の画面に並べない。
- `backup-create-a` の方式ごとの最初の反復を使用。画面は候補を説明用に再構成し、回答・時間・料金は記録から読む。`?model=azure|jev|rule` で判断役を共有できる。
- 集計は修復／判断時間／費用を切り替えて表示。CLIと共有の純粋な `summary.ts` で算出し、個別試行値と区別する。別時刻・別経路という注意書きは集計の直下に常時表示する。
- `email-not-sent-a` は両モデルに共通する限界として表示。選択・操作先・元アサーション・独立oracleが一致する場合は「GPT-5.5・Jevともに同じ結果」と一つにまとめ、無意味なモデル切り替えは置かない。不一致なら各記録を並べ、共通結果を捏造しない。検証コードの仕事をモデルの能力に数えない。
- 指定した実測・比較出典が揃わなければストーリーと集計を表示しない。未収集・一部実測を明示し、架空の成功や性能値で補わない。
- データがあればケース・方式・各試行を選択できる。件数の分母は選択条件内の試行で、検証欠損やコスト欠損を 0 としない。
- 一部モデルだけの実測では、そのモデル名と未実測モデルを表示する。provider名だけで実測済みとせず、API応答の選択とusageがある記録で判定する。決定論的ガードはモデルの実績に含めない。
- 元テストのアサーション、oracle、操作先の検証結果を独立して表示する。方式の優劣を推測しない。
- HTML は許可したタグと属性だけを再構築し、文字列をエスケープする。スクリプト、イベント属性、URL属性、元の CSS を引き継がない。
- iframe は空の `sandbox` と CSP を設定した非対話の静的表示。元 HTML は React のテキストとして閲覧可能。
- 外部フォント・分析タグ・API 呼び出し・認証情報の入力・ライブテスト実行はない。

リポジトリのルートから:

```powershell
npm run build:demo
npm run preview:demo
npx vitest run apps\demo\src\data.test.ts
npx vitest run --config vitest.browser.config.ts apps\demo\src\demo.browser.test.ts
```

ブラウザーテストにはインストール済みの Playwright Chromium が必要。
テストは公開 JSON を変更せず、空・記録あり・不正データを注入した専用ビルドを
`apps/demo/.browser-test-output/` に作り、ループバックの preview サーバーで検証後に削除する。
テスト専用の記録は実測ではなく、通常の公開ビルドには含まれない。

## Design

旧ワークベンチの情報密度と目的の曖昧さを見直し、ゼロベースで再設計。
データ台帳ではなく「選ぶ仕事を切り出す」という一つの持ち帰りを主役にした。
批判役を置き、実画面・最初の画面での理解・情報の段階的表示を検証する。
全324件のフィルター・HTML・差分・usage・SHA等は削除せず、任意に開く記録庫へ移した。
旧説明ケースのステップ／画面クエリは新デザインでは使用しない。

- Palette: page `#181a17`、text `#f3f1e7`、accent `#d5f56b`。
  紙色の実験台・触れるスイッチ・選択スタンプで遊び心を作る。既存のダーク初期値とライト切り替えを維持。
- Typography: 日本語UIはOSの可読性の高いフォント、コードのみCascadia Code／Consolas系。
  外部フォントやフォント用ネットワーク通信は追加しない。
- Layout: PCは左の問いと右の実験台。指標は1種類ずつ、根拠は折りたたみ。狭い画面では縦配置へ変える。
  コードブロック以外に横スクロールを発生させない。
- Interaction: 実際に操作できる要素だけをボタンにする。自動再生・点滅・装飾アニメーションなし。
  キーボード操作、focus表示、reduced motion、ライトテーマを維持する。

### Adopted skill and references

[Anthropic frontend-design](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/frontend-design)
をプロジェクトローカルの [.github/skills/frontend-design](../../.github/skills/frontend-design) に導入。
commit `34040c9c568585f6929bedeaad110ad08f079624` の原文を変更せず、同梱の
Apache-2.0 [LICENSE.txt](../../.github/skills/frontend-design/LICENSE.txt) を保持している。
Skillのblob SHAは `a5333457c414d20d625f307df945842c0952ecc3`。
グローバル設定・外部サービス・Skill用実行スクリプトは追加していない。

上記Skillは過去のデザインで導入したもの。今回の設計は既存のレイアウトを引き継がず、
目的と情報階層から作り直した。特定製品の画面・素材をコピーしてはいない。

[Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)
は操作性・アクセシビリティの参照として使用（Skillのインストールはしていない）。
[UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) も比較検討したが、
今回は追加の検索ツール・データベースを必要としない公式frontend-designを選んだ。
