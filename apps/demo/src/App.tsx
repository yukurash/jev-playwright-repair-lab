import { useEffect, useMemo, useState } from "react";
import type { Candidate, PublicDataset, TrialResult } from "../../../packages/core/src/index";
import { describeTrials, formatCost, formatNumber, providerNames, statusNames } from "./data";
import { snapshotDocument } from "./snapshot";

const repository = "https://github.com/yukurash/jev-playwright-repair-lab";
const illustrativeBefore = `<main><h1>通知の設定</h1><p>メールで受け取る通知を設定します。</p><label for="email">メールアドレス</label><input id="email" value="you@example.test"><button>保存</button></main>`;
const illustrativeAfter = `<main><h1>通知の設定</h1><p>メールで受け取る通知を設定します。</p><label for="email">メールアドレス</label><input id="email" value="you@example.test"><button>変更を保存</button></main>`;
const illustrativeOriginal = `await page.getByRole('button', { name: '保存', exact: true }).click();\nawait expect(page.getByRole('status')).toHaveText('保存しました');`;
const illustrativeRepaired = `await page.getByRole('button', { name: '変更を保存', exact: true }).click();\nawait expect(page.getByRole('status')).toHaveText('保存しました');`;
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
      return preference ? preference === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    } catch { return false; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try { localStorage.setItem("repair-lab-theme", dark ? "dark" : "light"); } catch { /* Storage can be disabled by browser policy. */ }
  }, [dark]);
  return <header className="site-header">
    <a href="#main" className="brand" aria-label="Jev Repair Lab ホーム">
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
      <span>jev <span className="brand-divider">/</span> <span className="brand-sub">repair lab</span></span>
    </a>
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
  const [step, setStep] = useState(0);
  const current = walkthrough[step]!;
  return <section id="explore" className="section">
    <SectionHeading number="01" label="HOW IT WORKS" title="小さな変更から、修復の境界を見る。"><span className="badge warning">説明用・実測ではありません</span></SectionHeading>
    <div className="lab-panel">
      <div className="steps" role="group" aria-label="修復の説明ステップ">
        {walkthrough.map((item, i) => <button type="button" key={item.label} onClick={() => setStep(i)} aria-pressed={i === step} className={`step ${i === step ? "active" : ""}`}><span className="step-number">0{i + 1}</span><span>{item.label}</span><Icon name="arrow" /></button>)}
      </div>
      <div className="walkthrough-copy" aria-live="polite"><div><p className="eyebrow">{current.note}</p><h3>{current.headline}</h3></div><p>{current.body}</p></div>
      <div className="snapshots"><Snapshot label="BEFORE" caption="変更前" source={illustrativeBefore} /><Snapshot label="AFTER" caption="変更後" source={illustrativeAfter} /></div>
      <div className="walkthrough-note"><Icon name="shield" /><p>{current.detail}</p></div>
      <CodeDiff original={illustrativeOriginal} repaired={illustrativeRepaired} explanation />
    </div>
    <div className="principles">
      <article><span className="principle-index">A / SAME INPUT</span><h3>選択の部分だけを交換</h3><p>ルール・Azure OpenAI・Jevに、同じ候補と文脈を。抽出と検証は共通です。</p></article>
      <article><span className="principle-index">B / SMALL PATCH</span><h3>直せる範囲を、狭くする</h3><p>候補IDからコードが最小差分を作成。任意コード生成やテストの削除は対象外です。</p></article>
      <article><span className="principle-index">C / SAFE TO STOP</span><h3>直さない、も大事な判断</h3><p>対象がなければ NO_REPAIR。曖昧なら ABSTAIN。対応外の構文はガードで停止します。</p></article>
    </div>
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
  return <>
    <a href="#main" className="skip-link">本文へスキップ</a>
    <div className="site-shell"><Header />
      <main id="main">
        <section className="hero">
          <div className="hero-copy"><p className="eyebrow"><span className="live-dot" /> AN EXPERIMENT IN TEST REPAIR</p><h1>テストを緑にするだけでは、<br /><span>修復とは呼べない。</span></h1><p className="hero-description">そのロケータは、本当に正しい操作先を指しているか。<br className="desktop-break" />ルール・通常LLM・Jevで、Playwright修復の「中身」を確かめる。</p><div className="hero-actions"><a className="primary-button" href="#explore">{empty ? "修復のしくみを見る" : "保存済み結果を見る"} <Icon name="arrow" /></a><span className="hero-caption">LOCATOR ONLY. ASSERTIONS INTACT.</span></div></div>
          <div className="hero-diagram" aria-label="元のテストのロケータだけを修復し、テストとoracleを別々に検証する"><div className="diagram-top"><span className="mono">test.spec.ts</span><span className="badge">locator-only</span></div><div className="diagram-code"><span className="muted">getByRole('button', &#123;</span><span className="diagram-removed">− name: '保存'</span><span className="diagram-added">+ name: '変更を保存'</span><span className="muted">&#125;).click()</span></div><div className="diagram-divider"><span />修復のあとに、ふたつの問い<span /></div><div className="diagram-checks"><div><Icon name="check" /><span>テストは通る？<small>ORIGINAL ASSERTIONS</small></span></div><div><Icon name="shield" /><span>操作は正しい？<small>INDEPENDENT ORACLE</small></span></div></div><p>説明用の差分 / 実測ではありません</p></div>
        </section>
        <section className="collection-status" aria-label="データ収集状況">
          <div className="collection-main"><span className={`status-dot ${empty ? "pending" : ""}`} /><div><span className="small-label">DATA STATUS</span><h2>{empty ? "未収集" : live ? "記録を公開中" : "API 実測は未収集"}</h2></div><p>{empty ? "実APIの結果は、まだありません。方式の優劣を示す数値は掲載していません。" : `${dataset.trials.length} 件の保存済み試行。API 実測 ${live} 件 / 決定論的実行 ${dataset.trials.length - live} 件。`}</p></div>
          <div className="collection-fact"><span className="small-label">EXECUTION</span><strong>ローカル CLI のみ</strong><span>このページから API を呼びません</span></div>
          <div className="collection-fact"><span className="small-label">PUBLICATION</span><strong>{dataset.publicationApproved ? "公開承認済み" : "実測公開待ち"}</strong><span>{empty ? "説明と実測を、混ぜない" : "保存記録をそのまま確認"}</span></div>
        </section>
        {empty ? <Walkthrough /> : <Results dataset={dataset} />}
        <div className="limitations"><Icon name="shield" /><div><strong>これは「どんなテストでも直す」デモではありません。</strong><p>自作fixtureと限定された構文が対象です。汎用的な優位性、すべての不具合の検出、誤修復ゼロを保証しません。ガードによる停止はモデルの判断能力と区別します。</p></div></div>
        <Reproduce />
      </main>
      <footer className="site-footer"><div><strong>jev / repair lab</strong><p>正しい修復を、確かめる。</p></div><div className="footer-meta"><span>{dataset.label}</span><span>Schema v{dataset.schemaVersion} · generated: {dataset.generatedAt ?? "未生成"}</span><span className="sha">Source SHA: {dataset.sourceSha ?? "未記録"}</span><a href={`${repository}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT License ↗</a></div></footer>
    </div>
  </>;
}
