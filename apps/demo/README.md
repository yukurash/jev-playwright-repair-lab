# Recorded comparison viewer

React / Vite の静的ビューア。公開パスは `/jev-playwright-repair-lab/`。
ビルド時に `data/public/results.json` を読み、core の `PublicDataset` / `TrialResult` と同じ契約をランタイムでも検証する。
不正形式・未承認の非空データはエラーとして表示し、空データへフォールバックしない。

- 未収集時は説明用の画面・コードだけを表示する。説明を実測値に見せない。
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
npx vitest run apps/demo/src/data.test.ts
npx vitest run --config vitest.browser.config.ts apps/demo/src/demo.browser.test.ts
```

ブラウザーテストにはインストール済みの Playwright Chromium が必要。
テストは公開 JSON を変更せず、空・記録あり・不正データを注入した専用ビルドを
`apps/demo/.browser-test-output/` に作り、ループバックの preview サーバーで検証後に削除する。
テスト専用の記録は実測ではなく、通常の公開ビルドには含まれない。

## Design

初期表示はダークな開発ツール型。紹介文よりも、ケース一覧・差分エディタ・独立検証を優先する。
説明モードの3ケースは手書きの概念例で、fixture実行結果やprovider応答ではない。
ケース、ステップ、差分／画面表示はURLクエリに保存し、再読み込み・共有で復元する。
実測データがある場合のフィルター・個別試行・欠損値表示は従来どおり維持する。

- Palette: page `#0e1219`、surface `#151b25`、text `#e7edf5`、
  muted `#a0adc0`、selection `#8ec3ff`。赤／緑は差分と検証状態に限定する。
- Typography: 日本語UIはOSの可読性の高いフォント、コードのみCascadia Code／Consolas系。
  外部フォントやフォント用ネットワーク通信は追加しない。
- Layout: PCは左ケース・中央コード・右検証の3列。狭い画面では縦配置へ変える。
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

固有の題材を主役にすること、意図のある配色・文字階層、カードの過剰使用を避けること、
空状態を次の操作につなげることを設計へ反映した。ユーザーが選択したダーク開発ツールという
方向を優先し、特定製品の画面・素材をコピーしてはいない。

[Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)
は操作性・アクセシビリティの参照として使用（Skillのインストールはしていない）。
[UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) も比較検討したが、
今回は追加の検索ツール・データベースを必要としない公式frontend-designを選んだ。
