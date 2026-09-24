import { useEffect, useMemo, useState } from "react";
import type { Candidate, PublicDataset, TrialResult } from "../../../packages/core/src/index";
import { describeTrials, formatCost, formatNumber, providerNames, statusNames } from "./data";
import { snapshotDocument } from "./snapshot";

const repository = "https://github.com/yukurash/jev-playwright-repair-lab";
const illustrativeBefore = `<main><h1>通知の設定</h1><p>メールで受け取る通知を設定します。</p><label for="email">メールアドレス</label><input id="email" value="you@example.test"><button>保存</button></main>`;
const illustrativeAfter = `<main><h1>通知の設定</h1><p>メールで受け取る通知を設定します。</p><label for="email">メールアドレス</label><input id="email" value="you@example.test"><button>変更を保存</button></main>`;
const illustrativeOriginal = `await page.getByRole('button', { name: '保存', exact: true }).click();\nawait expect(page.getByRole('status')).toHaveText('保存しました');`;
const illustrativeRepaired = `await page.getByRole('button', { name: '変更を保存', exact: true }).click();\nawait expect(page.getByRole('status')).toHaveText('保存しました');`;
const examples = [
  { id: "rename", title: "ボタン名の変更", file: "notifications.spec.ts", kind: "Locator not found", description: "保存 → 変更を保存", before: illustrativeBefore, after: illustrativeAfter, original: illustrativeOriginal, repaired: illustrativeRepaired, target: "変更を保存", context: "通知の設定", result: "修復できる例", assertion: true, oracle: true, targetCorrect: true, detail: "同じ通知設定を保存する操作です。ロケータだけを変え、期待値はそのままにします。" },
  { id: "wrong-target", title: "通ったのに、違う", file: "checkout.spec.ts", kind: "Wrong target", description: "テストの緑化 ≠ 修復成功", before: '<main><h1>注文の確認</h1><p>注文内容を確認してください。</p><button>確定する</button></main>', after: '<main><h1>注文の確認</h1><p>注文と見積もりでは保存先が異なります。</p><button>見積もりを保存</button><button>注文を確定</button></main>', original: "await page.getByRole('button', { name: '確定する', exact: true }).click();\nawait expect(page.getByRole('status')).toHaveText('完了しました');", repaired: "await page.getByRole('button', { name: '見積もりを保存', exact: true }).click();\nawait expect(page.getByRole('status')).toHaveText('完了しました');", target: "見積もりを保存", context: "注文の確認", result: "修復を却下する例", assertion: true, oracle: false, targetCorrect: false, detail: "見積もり保存でも「完了しました」は表示できます。しかし注文は作成されません。緩いアサーションを独立検証で補います。" },
  { id: "missing", title: "修復しない判断", file: "coupon.spec.ts", kind: "No matching target", description: "機能がなくなったら、止まる", before: '<main><h1>クーポン</h1><p>注文に割引を適用します。</p><button>適用する</button></main>', after: '<main><h1>クーポン</h1><p>クーポンの受け付けは終了しました。</p><button>注文に戻る</button></main>', original: "await page.getByRole('button', { name: '適用する', exact: true }).click();\nawait expect(page.getByRole('status')).toHaveText('適用しました');", repaired: undefined, target: "NO_REPAIR", context: "クーポンの受け付け終了", result: "修復しない例", assertion: null, oracle: null, targetCorrect: null, detail: "「注文に戻る」は代わりの操作先ではありません。対応する対象がない場合は、書き換えずに停止します。" },
] as const;
const walkthrough = [
  { label: "失敗をとらえる", headline: "名前が変わる。テストが止まる。", body: "「保存」が「変更を保存」に変わると、元のロケータは対象を見つけられません。操作の目的は、そのままです。", note: "BEFORE → AFTER", detail: "画面は説明用の静的スナップショットです。ボタンを押しても処理は実行されません。" },
  { label: "候補から選ぶ", headline: "書き直すのは、ロケータだけ。", body: "コードが抽出した候補と周辺文脈を各方式に渡します。返すのは候補ID、NO_REPAIR、ABSTAINのいずれか。モデルはコードを書きません。", note: "LIMITED CHOICES", detail: "説明例の候補 c0: button「変更を保存」／文脈「通知の設定」。この例は実際のproviderの応答ではありません。" },
  { label: "正しさを確かめる", headline: "緑のテストと、正しい操作は別。", body: "元のアサーションを変えずに再実行。その結果と、独立したoracleによる状態検証・操作先の正しさを分けて記録します。", note: "VERIFY, DON'T ASSUME", detail: "機能の不具合を隠す修復は成功とみなしません。テスト通過だけを根拠に、修復の正しさは判断しません。" },
] as const;

function Icon({ name }: { name: "arrow" | "sun" | "moon" | "code" | "external" | "check" | "shield" }) {
  const paths = {
    arrow: <><path d="M4 12h15M13 6l6 6-6 6" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    moon: <path d="M20 14a8 8 0 0 1-10-10 8.5 8.5 0 1 0 10 10Z" />,
    code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" /></>,
    external: <><path d="M14 3h7v7m0-7L11 13M10 4H4v16h16v-6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    shield: <><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z" /><path d="m8 12 3 3 5-6" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Header() {
  const [dark, setDark] = useState(() => {
    try {
      const preference = localStorage.getItem("repair-lab-theme");
      return preference !== "light";
    } catch { return true; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e1219" : "#f2f4f8");
    try { localStorage.setItem("repair-lab-theme", dark ? "dark" : "light"); } catch { /* Storage can be disabled by browser policy. */ }
  }, [dark]);
  return <header className="site-header">
    <a href="#main" className="brand" aria-label="Jev Repair Lab ホーム">
      <span className="brand-mark" aria-hidden="true"><Icon name="code" /></span>
      <span translate="no">Jev <span className="brand-sub">Repair Lab</span></span>
    </a>
    <span className="header-context">Playwright / locator repair</span>
    <nav aria-label="メインナビゲーション">
      <a href="#explore" className="nav-explore">ラボを見る</a>
      <a href="#reproduce">再現する</a>
      <a href={repository} target="_blank" rel="noreferrer" className="repo-link">GitHub <Icon name="external" /></a>
      <button type="button" className="icon-button" onClick={() => setDark(!dark)} aria-label={dark ? "ライトモードに切り替える" : "ダークモードに切り替える"}><Icon name={dark ? "sun" : "moon"} /></button>
    </nav>
  </header>;
}

function SectionHeading({ number, label, title, children }: { number: string; label: string; title: string; children?: React.ReactNode }) {
  return <div className="section-heading"><div><p className="eyebrow"><span>{number}</span> {label}</p><h2>{title}</h2></div>{children}</div>;
}

function Snapshot({ source, label, caption }: { source: string; label: string; caption: string }) {
  const srcDoc = useMemo(() => snapshotDocument(source), [source]);
  return <figure className="snapshot">
    <figcaption><span className="window-dots" aria-hidden="true"><i /><i /><i /></span><strong>{label}</strong><span>{caption}</span></figcaption>
    <iframe sandbox="" referrerPolicy="no-referrer" title={`${label} 静的画面`} srcDoc={srcDoc} loading="lazy" />
    <details className="source-detail"><summary>記録された HTML を読む</summary><pre><code>{source}</code></pre></details>
  </figure>;
}

function CodeDiff({ original, repaired, explanation = false }: { original: string; repaired?: string; explanation?: boolean }) {
  const before = original.split("\n");
  const after = repaired?.split("\n");
  return <div className="diff-view">
    <div className="panel-heading"><span><Icon name="code" /> {explanation ? "説明用の locator 差分" : "記録されたテスト差分"}</span><span className="small-label">ASSERTIONS UNCHANGED</span></div>
    <div className="diff-columns">
      <div><p className="code-caption">元のテスト</p><pre aria-label="元のテストコード"><code>{before.map((line, i) => <span key={i} className={`code-line ${after && line !== after[i] ? "removed" : ""}`}><span className="line-number" aria-hidden="true">{i + 1}</span><span>{line}</span></span>)}</code></pre></div>
      <div><p className="code-caption">修復後の記録</p>{after ? <pre aria-label="修復後のテストコード"><code>{after.map((line, i) => <span key={i} className={`code-line ${line !== before[i] ? "added" : ""}`}><span className="line-number" aria-hidden="true">{i + 1}</span><span>{line}</span></span>)}</code></pre> : <p className="code-empty">修復後コードは未記録です。元のコードで補完しません。</p>}</div>
    </div>
    <p className="diff-note">変更対象はロケータのみ。期待値・アサーション・操作引数は変更しません。差分の色は行単位の比較です。</p>
  </div>;
}

function Walkthrough() {
  function readLocation() {
    const params = new URLSearchParams(location.search);
    return {
      exampleId: examples.find((example) => example.id === params.get("example"))?.id ?? "rename",
      step: ["0", "1", "2"].includes(params.get("step") ?? "") ? Number(params.get("step")) : 1,
      view: params.get("view") === "preview" ? "preview" as const : "diff" as const,
    };
  }
  const [selection, setSelection] = useState(readLocation);
  const { step, view } = selection;
  const example = examples.find((item) => item.id === selection.exampleId) ?? examples[0];
  useEffect(() => {
    const restore = () => setSelection(readLocation());
    addEventListener("popstate", restore);
    return () => removeEventListener("popstate", restore);
  }, []);
  function select(next: typeof selection) {
    setSelection(next);
    const url = new URL(location.href);
    url.searchParams.set("example", next.exampleId);
    url.searchParams.set("step", String(next.step));
    url.searchParams.set("view", next.view);
    history.replaceState(null, "", url);
  }
  const current = walkthrough[step]!;
  return <section id="explore" className="workbench" aria-label="修復ワークベンチ">
    <div className="workbench-toolbar"><div><Icon name="code" /><h2>修復ワークベンチ</h2><span className="workspace-mode">ガイド</span></div><span className="badge warning">説明用・実測ではありません</span></div>
    <div className="workspace-grid">
      <aside className="case-sidebar" aria-label="説明ケース">
        <div className="sidebar-heading"><h3>ケース</h3><span>3 examples</span></div>
        <div className="case-list">{examples.map((item) =>
          <button type="button" key={item.id} aria-pressed={item.id === example.id} className={`case-button ${item.id === example.id ? "active" : ""}`} onClick={() => select({ ...selection, exampleId: item.id })}>
            <span className={`case-indicator ${item.id}`} aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.description}</small></span>
          </button>,
        )}</div>
        <div className="sidebar-providers"><h3>比較する判断役</h3><ul><li><span className="provider-dot rule" />ルール<span>未比較</span></li><li><span className="provider-dot azure" />GPT-5.5<span>未比較</span></li><li><span className="provider-dot jev" />Jev<span>未比較</span></li></ul><p>同じ候補、同じ文脈。<br />選ぶ部分だけを交換します。</p></div>
        <a className="sidebar-link" href={`${repository}/tree/main/fixtures`} target="_blank" rel="noreferrer">検証用の60ケースを見る<Icon name="external" /></a>
      </aside>
      <div className="editor-pane">
        <div className="editor-toolbar"><span className="file-label" translate="no"><span className="ts-icon">TS</span>{example.file}</span><div className="view-switch" role="group" aria-label="表示内容"><button type="button" aria-pressed={view === "diff"} onClick={() => select({ ...selection, view: "diff" })}>差分</button><button type="button" aria-pressed={view === "preview"} onClick={() => select({ ...selection, view: "preview" })}>画面</button></div></div>
        <div className="steps" role="group" aria-label="修復の説明ステップ">
          {walkthrough.map((item, i) => <button type="button" key={item.label} onClick={() => select({ ...selection, step: i })} aria-pressed={i === step} className={`step ${i === step ? "active" : ""}`}><span className="step-number">0{i + 1}</span><span>{item.label}</span></button>)}
        </div>
        <div className="walkthrough-copy" aria-live="polite"><h3>{example.id === "rename" ? current.headline : example.title}</h3><p>{example.id === "rename" ? current.body : example.detail}</p></div>
        {view === "diff" ? <div className="example-editor">
          <div className="editor-section-heading"><span>{step === 0 ? "失敗したロケータ" : "ロケータだけを変更"}</span><span className="badge">{step === 0 ? "変更前" : "変更案の説明"}</span></div>
          <pre aria-label="説明用のテスト差分"><code>
            <span className="code-line code-context"><span className="line-number">1</span><span><b>test</b>(<em>'{example.title}'</em>, async (&#123; page &#125;) =&gt; &#123;</span></span>
            <span className="code-line removed"><span className="line-number">2</span><span className="diff-sign">−</span><span>{example.original.split("\n")[0]}</span></span>
            {step > 0 && example.repaired && <span className="code-line added"><span className="line-number">2</span><span className="diff-sign">+</span><span>{example.repaired.split("\n")[0]}</span></span>}
            <span className="code-line code-context"><span className="line-number">3</span><span>{example.original.split("\n")[1]}</span></span>
            <span className="code-line code-context"><span className="line-number">4</span><span>&#125;);</span></span>
          </code></pre>
          <div className="assertion-lock"><Icon name="shield" /><span>アサーション・期待値・操作引数は変更しない</span></div>
          {step > 0 && !example.repaired && <div className="stop-note"><strong>NO_REPAIR</strong><p>対応する操作先がないため、コードは変更しません。</p></div>}
          <div className="diagnostic"><div><span className="diagnostic-symbol">!</span><strong>{step === 0 ? "Locator not found" : example.id === "rename" ? "変更案の確認ポイント" : example.kind}</strong><span>説明例</span></div><p>{step === 0 ? "元の名前では、操作先を一意に見つけられません。" : example.detail}</p><code>{example.original.split("\n")[0]}</code></div>
        </div> : <div className="preview-pane"><div className="snapshots"><Snapshot label="BEFORE" caption="変更前の説明画面" source={example.before} /><Snapshot label="AFTER" caption="変更後の説明画面" source={example.after} /></div><p className="snapshot-disclaimer muted">説明用の静的画面です。ボタン操作・推論・テストは実行しません。</p></div>}
        <div className="editor-bottom"><span><span className="status-dot" />ロケータ限定</span><span>TypeScript</span><span>読み取り専用</span></div>
      </div>
      <aside className="inspector" aria-label="独立検証の説明">
        <div className="inspector-heading"><Icon name="shield" /><h3>検証結果</h3><span>説明例</span></div>
        <div className="inspection-summary"><span className={`inspection-symbol ${step === 2 && example.oracle === false ? "failure" : ""}`} aria-hidden="true">{step < 2 ? "?" : example.oracle === false ? "×" : example.oracle === true ? "✓" : "—"}</span><strong>{step < 2 ? "通るだけでは、足りない。" : example.result}</strong><p>{step < 2 ? "テストと実際の状態を、別々に確かめます。" : example.detail}</p></div>
        <Outcome label="元のアサーション" value={step === 2 ? example.assertion : null} note="期待値を変更せずに確認" />
        <Outcome label="独立した状態検証" value={step === 2 ? example.oracle : null} note="アプリの結果は正しいか" />
        <Outcome label="操作先の正しさ" value={step === 2 ? example.targetCorrect : null} note="本来の対象を選んだか" />
        <div className="selection-note"><span>選択内容の説明</span><code>{step === 0 ? "まだ選択しません" : example.target}</code><p>{step === 0 ? "次のステップで変更案を確認できます。" : example.context}</p></div>
        <p className="inspector-disclaimer">実際のモデルの応答ではありません。速度・費用・成功率は未掲載です。</p>
        <button type="button" className="next-step" onClick={() => select({ ...selection, step: (step + 1) % walkthrough.length })}>{step === 2 ? "最初から見る" : step === 0 ? "変更案を見る" : "独立検証を見る"}<Icon name="arrow" /></button>
      </aside>
    </div>
    <div className="workbench-footer"><span>ブラウザ内の説明表示</span><span>API呼び出しなし<span className="footer-separator" />実測データと分離</span></div>
  </section>;
}

function Outcome({ label, value, note }: { label: string; value: boolean | null; note: string }) {
  return <div className="outcome"><div><strong>{label}</strong><p>{note}</p></div><span className={`badge ${value === null ? "" : value ? "positive" : "negative"}`}>{value === null ? "未検証" : value ? "PASS" : "FAIL"}</span></div>;
}

function locatorText(candidate: Candidate): string {
  const locator = candidate.locator;
  const target = locator.kind === "role" ? `${locator.role}「${locator.name}」` : `label「${locator.label}」`;
  return locator.scope ? `${locator.scope} › ${target}` : target;
}

function TrialDetail({ trial, index }: { trial: TrialResult; index: number }) {
  const version = trial.modelVersion ?? "未記録";
  return <div className="trial-detail" key={index}>
    <div className="trial-title"><div><p className="eyebrow">{trial.caseId} / {trial.category}</p><h3>{trial.title}</h3></div><span className="badge">{statusNames[trial.status]}</span></div>
    <div className="record-meta"><span>{trial.split}</span><span>family: {trial.familyId}</span><span>{trial.inference === "live" ? "API 実測の保存記録" : "決定論的実行の保存記録"}</span><span>{trial.recordedAt}</span></div>
    <div className="snapshots"><Snapshot source={trial.beforeHtml} label="BEFORE" caption="変更前の保存画面" /><Snapshot source={trial.afterHtml} label="AFTER" caption="変更後の保存画面" /></div>
    <p className="muted snapshot-disclaimer">静的 HTML の閲覧です。危険な要素・外部リソース・元ページのスタイルは除去しています。Playwright やアプリの動作は再実行しません。</p>
    <CodeDiff original={trial.originalTest} repaired={trial.repairedTest} />
    <div className="trial-grid">
      <section className="detail-panel"><div className="detail-heading"><h4>選択と、その文脈</h4><span className="mono">{trial.decision ?? "未記録"}</span></div>
        {trial.candidates.length ? <ul className="candidate-list">{trial.candidates.map((candidate) => <li key={candidate.id} className={candidate.id === trial.decision ? "chosen" : ""}><div><span className="mono">{candidate.id}</span><strong>{locatorText(candidate)}</strong>{candidate.id === trial.decision && <span className="badge positive">選択</span>}</div><p>{candidate.context || "文脈の記録なし"}</p></li>)}</ul> : <p className="muted">候補は記録されていません。</p>}
        <p className="muted">NO_REPAIR = 修復先なし / ABSTAIN = 判断保留</p>
        <p className="muted">評価専用の期待選択: <code>{trial.expectedDecision ?? "未記録"}</code> · 修復可能ケース: {trial.repairable ? "はい" : "いいえ"}</p>
        {(trial.reason || trial.error) && <p className="notice">{trial.error ?? trial.reason}</p>}
      </section>
      <section className="detail-panel"><div className="detail-heading"><h4>「通った」と「正しい」を分ける</h4><Icon name="shield" /></div>
        <Outcome label="変更前のベースライン" value={trial.baselinePassed} note="元のアプリと元のテスト" />
        <Outcome label="元のアサーション" value={trial.originalTestPassed} note="修復後も期待値を変えずに通過したか" />
        <Outcome label="独立 oracle の状態検証" value={trial.oraclePassed} note="評価用の独立した状態チェック" />
        <Outcome label="操作先の正しさ" value={trial.targetCorrect} note="本来の対象を選んだか" />
        <p className="muted">修復ステータスだけでは正しさを保証しません。未検証は失敗にも成功にも換算しません。</p>
      </section>
    </div>
    <div className="trial-grid">
      <section className="detail-panel"><h4>この試行の時間と利用量</h4><dl className="metric-list"><div><dt>全体</dt><dd>{formatNumber(trial.latency.totalMs)} <small>ms</small></dd></div><div><dt>取得 / 判断 / 検証</dt><dd>{[trial.latency.captureMs, trial.latency.decisionMs, trial.latency.validationMs].map(formatNumber).join(" / ")} <small>ms</small></dd></div><div><dt>記録済みコスト</dt><dd>{formatCost(trial.costUsd)}</dd></div><div><dt>入力 / 出力 tokens</dt><dd>{trial.usage ? `${formatNumber(trial.usage.inputTokens)} / ${formatNumber(trial.usage.outputTokens)}` : "未記録"}</dd></div><div><dt>reasoning / cached input</dt><dd>{trial.usage?.reasoningTokens === undefined ? "未記録" : formatNumber(trial.usage.reasoningTokens)} / {trial.usage?.cachedInputTokens === undefined ? "未記録" : formatNumber(trial.usage.cachedInputTokens)}</dd></div></dl><p className="muted">欠損値は 0 とみなしません。コストは保存値のみで、トークン数からの独自推定は行いません。</p></section>
      <section className="detail-panel"><h4>再現のための記録</h4><dl className="metric-list"><div><dt>provider / model</dt><dd>{providerNames[trial.provider]} / {trial.model}</dd></div><div><dt>モデル版</dt><dd>{version}</dd></div><div><dt>schema</dt><dd>v{trial.schemaVersion}</dd></div><div><dt>source SHA</dt><dd className="sha">{trial.sourceSha}</dd></div><div><dt>confidence（自己申告）</dt><dd>{trial.confidence === undefined ? "未記録" : String(trial.confidence)}</dd></div></dl><p className="muted">confidence はモデルの自己申告で、正解率ではありません。モデル版がない記録から特定の版を推定しません。</p>{trial.probabilities && <details><summary>記録された候補別の確率</summary><pre className="probability-data">{JSON.stringify(trial.probabilities, null, 2)}</pre></details>}</section>
    </div>
  </div>;
}

function Results({ dataset }: { dataset: PublicDataset }) {
  const cases = [...new Set(dataset.trials.map((trial) => trial.caseId))];
  const [caseId, setCaseId] = useState(cases[0] ?? "");
  const [provider, setProvider] = useState("all");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const filtered = dataset.trials.map((trial, index) => ({ trial, index })).filter(({ trial }) => trial.caseId === caseId && (provider === "all" || trial.provider === provider));
  const selected = filtered.find(({ index }) => index === selectedIndex) ?? filtered[0];
  const summary = describeTrials(filtered.map(({ trial }) => trial));
  return <section className="section" id="explore">
    <SectionHeading number="01" label="RECORDED TRIALS" title="結論より先に、ひとつの試行を見る。"><span className="badge positive">保存済み記録</span></SectionHeading>
    <div className="lab-panel">
      <div className="result-filters">
        <div className="filter-field"><label htmlFor="case-select">ケース</label><select id="case-select" value={caseId} onChange={(event) => { setCaseId(event.target.value); setSelectedIndex(null); }}>{cases.map((id) => <option key={id} value={id}>{id} — {dataset.trials.find((trial) => trial.caseId === id)?.title}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="provider-select">方式</label><select id="provider-select" value={provider} onChange={(event) => { setProvider(event.target.value); setSelectedIndex(null); }}><option value="all">すべての方式</option>{Object.entries(providerNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
        <div className="filter-field"><label htmlFor="trial-select">保存された試行</label><select id="trial-select" value={selected?.index ?? ""} onChange={(event) => setSelectedIndex(Number(event.target.value))} disabled={!filtered.length}>{filtered.length ? filtered.map(({ trial, index }) => <option key={index} value={index}>#{index + 1} · {providerNames[trial.provider]} · {trial.recordedAt} · {statusNames[trial.status]}</option>) : <option value="">記録なし</option>}</select></div>
      </div>
      <div className="descriptive-counts" aria-live="polite"><span>選択条件内: <strong>{summary.total} 試行</strong></span><span>修復案適用: <strong>{summary.repaired} / {summary.total}</strong></span><span>oracle・操作先とも PASS: <strong>{summary.verified} / {summary.evaluated} 検証済み</strong></span><span>コスト小計: <strong>{formatCost(summary.costUsd)}</strong>（記録 {summary.measuredCosts} / {summary.total}）</span></div>
      <p className="counts-note">記述的な件数です。未検証 {summary.total - summary.evaluated} 試行を正否の分母から除外。反復・分割・ケース構成を調整した性能比較ではありません。</p>
      {selected ? <TrialDetail trial={selected.trial} index={selected.index} /> : <div className="no-matching-trials" role="status"><h3>この条件の記録はありません。</h3><p>別の方式またはケースを選んでください。未実行の組み合わせを補完しません。</p></div>}
    </div>
  </section>;
}

function Reproduce() {
  return <section className="section reproduce-section" id="reproduce">
    <div><p className="eyebrow"><span>02</span> REPRODUCIBLE BY DESIGN</p><h2>ブラウザでは、読む。<br />ローカルで、確かめる。</h2><p>このページは公開用データをビルド時に読み込む静的ビューアです。APIキー入力、ライブ推論、Playwrightの実行機能はありません。</p><a href={repository} target="_blank" rel="noreferrer" className="button-link">コードと再現手順を開く <Icon name="external" /></a></div>
    <div className="reproduce-card">
      <div className="panel-heading"><span><Icon name="code" /> LOCAL WORKFLOW</span><span className="small-label">Node.js 24 / Chromium</span></div>
      <ol className="reproduce-steps">
        <li><span>01</span><div><h3>セットアップ・無課金の検証</h3><code>npm ci<br />npx playwright install chromium<br />npm run verify</code></div></li>
        <li><span>02</span><div><h3>ローカルで記録を作る</h3><p>READMEに従い capture → repair → evaluate。実APIは認証・予算・利用条件を確認した場合のみ。</p></div></li>
        <li><span>03</span><div><h3>検査・承認した結果だけ公開</h3><code>npm run check:public<br />npm run build:demo<br />npm run preview:demo</code></div></li>
      </ol>
    </div>
  </section>;
}

export function DataError({ message }: { message: string }) {
  return <main className="data-error"><p className="eyebrow">DATA VALIDATION ERROR</p><h1>公開データを表示できません。</h1><p role="alert">{message}</p><p>壊れた記録を空の結果や成功値として表示しません。データ形式と公開承認を確認し、再ビルドしてください。</p><a href={repository}>リポジトリを確認する →</a></main>;
}

export function App({ dataset }: { dataset: PublicDataset }) {
  const empty = dataset.trials.length === 0;
  const live = dataset.trials.filter((trial) => trial.inference === "live").length;
  const measuredModels = (["azure", "jev"] as const).filter((provider) => dataset.trials.some((trial) => trial.provider === provider && trial.inference === "live" && trial.decision !== null && trial.usage !== undefined));
  const modelNames = { azure: "GPT-5.5", jev: "Jev" };
  const pendingModels = (["azure", "jev"] as const).filter((provider) => !measuredModels.includes(provider)).map((provider) => modelNames[provider]);
  const collectionTitle = empty ? "未収集" : measuredModels.length === 1 ? `${modelNames[measuredModels[0]!]}のみ実測` : measuredModels.length === 2 ? "記録を公開中" : "API 実測は未収集";
  return <>
    <a href="#main" className="skip-link">本文へスキップ</a>
    <div className="site-shell"><Header />
      <main id="main">
        <section className="workspace-intro">
          <div><h1>テストは通った。<span>本当に直った？</span></h1><p>ルール・GPT-5.5・Jev。操作先を選ぶ判断を交換し、修復の正しさを確かめる。</p></div>
          <a className="button-link" href={`${repository}#local-workflow`} target="_blank" rel="noreferrer"><Icon name="code" />ローカルで試す<Icon name="external" /></a>
        </section>
        <section className="collection-status" aria-label="データ収集状況">
          <div className="collection-main"><span className={`status-dot ${pendingModels.length ? "pending" : ""}`} /><span>API比較</span><h2>{collectionTitle}</h2><p>{empty ? "まずは説明ケースで、修復と検証の流れを確認できます。" : `${dataset.trials.length} 件の保存済み試行。API方式の試行 ${live} 件 / 決定論的実行（ガードを含む）${dataset.trials.length - live} 件。${pendingModels.length ? ` ${pendingModels.join("・")}は未実測です。方式間の優劣はまだ比較できません。` : ""}`}</p></div>
          <span className="collection-detail">{dataset.publicationApproved ? "公開承認済みの記録" : "方式の優劣・性能値は未掲載"}</span>
        </section>
        {empty ? <Walkthrough /> : <Results dataset={dataset} />}
        <div className="principles"><article><Icon name="code" /><div><h3>選ぶ部分だけを交換</h3><p>候補の抽出と検証は共通。判断役に同じ候補・文脈を渡します。</p></div></article><article><Icon name="shield" /><div><h3>直せるのは、ロケータだけ</h3><p>アサーションはそのまま。対象なし・曖昧な場合は停止できます。</p></div></article><article><Icon name="check" /><div><h3>成功を、独立して検証</h3><p>自作fixtureと限定構文が対象。汎用的な安全性を保証するものではありません。</p></div></article></div>
        <Reproduce />
      </main>
      <footer className="site-footer"><div><strong>jev / repair lab</strong><p>正しい修復を、確かめる。</p></div><div className="footer-meta"><span>{dataset.label}</span><span>Schema v{dataset.schemaVersion} · generated: {dataset.generatedAt ?? "未生成"}</span><span className="sha">Source SHA: {dataset.sourceSha ?? "未記録"}</span><a href={`${repository}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT License ↗</a></div></footer>
    </div>
  </>;
}
