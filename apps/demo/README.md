# Recorded comparison viewer

React / Vite の静的ビューア。公開パスは `/jev-playwright-repair-lab/`。
ビルド時に `data/public/results.json` を読み、core の `PublicDataset` / `TrialResult` と同じ契約をランタイムでも検証する。
不正形式・未承認の非空データはエラーとして表示し、空データへフォールバックしない。

- 未収集時は説明用の画面・コードだけを表示する。説明を実測値に見せない。
- データがあればケース・方式・各試行を選択できる。件数の分母は選択条件内の試行で、検証欠損やコスト欠損を 0 としない。
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
