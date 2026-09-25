import { useMemo, useState } from "react";
import type { Candidate, PublicDataset, TrialResult } from "../../../packages/core/src/index";
import { describeTrials, formatCost, formatNumber, providerNames, statusNames } from "./data";
import { snapshotDocument } from "./snapshot";

export function Outcome({ label, value }: { label: string; value: boolean | null }) {
  return <div className="outcome"><strong>{label}</strong><span className={`badge ${value === null ? "" : value ? "positive" : "negative"}`}>{value === null ? "未検証" : value ? "PASS" : "FAIL"}</span></div>;
}

export function candidateName(candidate: Candidate): string {
  return candidate.locator.kind === "role" ? candidate.locator.name : candidate.locator.label;
}

function Snapshot({ source, label }: { source: string; label: string }) {
  const srcDoc = useMemo(() => snapshotDocument(source), [source]);
  return <figure className="snapshot">
    <figcaption>{label} / 保存された画面</figcaption>
    <iframe title={`${label} 静的画面`} sandbox="" referrerPolicy="no-referrer" srcDoc={srcDoc} />
    <details><summary>記録された HTML を読む</summary><pre className="source-detail"><code>{source}</code></pre></details>
  </figure>;
}

export function CodeDiff({ original, repaired }: { original: string; repaired?: string }) {
  const before = original.split("\n");
  const after = repaired?.split("\n");
  return <div className="diff-view">
    <p className="eyebrow">LOCATOR DIFF <span>アサーション・操作引数は変更しない</span></p>
    <div className="diff-columns">
      <div><h4>元のテスト</h4><pre aria-label="元のテストコード"><code>{before.map((line, i) => <span key={i} className={`code-line ${after && line !== after[i] ? "removed" : ""}`}>{line}{"\n"}</span>)}</code></pre></div>
      <div><h4>修復後の記録</h4>{after ? <pre aria-label="修復後のテストコード"><code>{after.map((line, i) => <span key={i} className={`code-line ${line !== before[i] ? "added" : ""}`}>{line}{"\n"}</span>)}</code></pre> : <p>修復後コードは未記録です。元のコードで補完しません。</p>}</div>
    </div>
  </div>;
}

function TrialDetail({ trial }: { trial: TrialResult }) {
  return <article className="trial-detail">
    <div className="trial-title"><div><p className="eyebrow">{trial.caseId} / {trial.category}</p><h3>{trial.title}</h3></div><span className="badge">{statusNames[trial.status]}</span></div>
    <p className="record-meta">{trial.split} / family: {trial.familyId} / {trial.inference === "live" ? "API 実測の保存記録" : "決定論的実行の保存記録"} / {trial.recordedAt}</p>
    <div className="trial-grid">
      <section><h4>選択と、その文脈</h4>
        <p>選択: <code>{trial.decision ?? "未記録"}</code></p>
        <ul className="candidate-list">{trial.candidates.map((candidate) => <li key={candidate.id} className={candidate.id === trial.decision ? "chosen" : ""}><strong>{candidate.id} / {candidate.locator.scope && `${candidate.locator.scope} › `}{candidateName(candidate)}</strong><p>{candidate.context || "文脈の記録なし"}</p></li>)}</ul>
        <p className="muted">評価専用の期待選択: {trial.expectedDecision ?? "未記録"} / 修復可能: {trial.repairable ? "はい" : "いいえ"}</p>
        {(trial.reason || trial.error) && <p className="notice">{trial.error ?? trial.reason}</p>}
      </section>
      <section><h4>「通った」と「正しい」を分ける</h4>
        <Outcome label="変更前のベースライン" value={trial.baselinePassed} />
        <Outcome label="元のアサーション" value={trial.originalTestPassed} />
        <Outcome label="独立 oracle の状態検証" value={trial.oraclePassed} />
        <Outcome label="操作先の正しさ" value={trial.targetCorrect} />
        <p className="muted">未検証は成功にも失敗にも換算しません。</p>
      </section>
    </div>
    <CodeDiff original={trial.originalTest} repaired={trial.repairedTest} />
    <details className="record-fold"><summary>変更前後の画面と HTML</summary>
      <p className="muted">外部リソース・スクリプトを除いた静的表示です。アプリは動作しません。</p>
      <div className="snapshots"><Snapshot source={trial.beforeHtml} label="BEFORE" /><Snapshot source={trial.afterHtml} label="AFTER" /></div>
    </details>
    <div className="trial-grid">
      <section><h4>時間・利用量</h4><dl className="metric-list">
        <div><dt>全体</dt><dd>{formatNumber(trial.latency.totalMs)} ms</dd></div>
        <div><dt>取得 / 判断 / 検証</dt><dd>{[trial.latency.captureMs, trial.latency.decisionMs, trial.latency.validationMs].map(formatNumber).join(" / ")} ms</dd></div>
        <div><dt>記録済みコスト</dt><dd>{formatCost(trial.costUsd)}</dd></div>
        <div><dt>入力 / 出力 tokens</dt><dd>{trial.usage ? `${trial.usage.inputTokens} / ${trial.usage.outputTokens}` : "未記録"}</dd></div>
        <div><dt>reasoning / cached input</dt><dd>{trial.usage?.reasoningTokens ?? "未記録"} / {trial.usage?.cachedInputTokens ?? "未記録"}</dd></div>
      </dl><p className="muted">欠損値は 0 とみなしません。</p></section>
      <section><h4>再現のための記録</h4><dl className="metric-list">
        <div><dt>provider / model</dt><dd>{providerNames[trial.provider]} / {trial.model}</dd></div>
        <div><dt>モデル版</dt><dd>{trial.modelVersion ?? "未記録"}</dd></div>
        <div><dt>schema / source SHA</dt><dd>v{trial.schemaVersion} / {trial.sourceSha}</dd></div>
        <div><dt>confidence（自己申告）</dt><dd>{trial.confidence ?? "未記録"}</dd></div>
      </dl><p className="muted">confidence はモデルの自己申告で、正解率ではありません。</p>
      {trial.route && <p className="muted">接続経路: {trial.route === "openrouter" ? "OpenRouter" : "Vercel AI Gateway"}。判断時間は中継を含みます。</p>}
      {trial.probabilities && <details><summary>記録された候補別の確率</summary><pre>{JSON.stringify(trial.probabilities, null, 2)}</pre></details>}</section>
    </div>
  </article>;
}

export function ComparisonProvenance({ dataset }: { dataset: PublicDataset }) {
  const comparison = dataset.comparison;
  return <section className="comparison-provenance" aria-label="比較の条件と出典">
    <h3>比較の条件と出典</h3>
    {comparison ? <>
      <p>方式ごとに別スケジュールで収集し、方式間のランダム化・交互実行はしていません。判断時間は中継の影響を含み、コストの計上基準も異なります。</p>
      <p>{comparison.caseIds.length} ケース × {comparison.repetitions} 反復 / 方式、seed {comparison.seed}。保存された画面・候補・元テスト・期待ラベルの一致を検証済みです。</p>
      <ul className="provenance-runs">{comparison.runs.map((run) => <li key={run.provider}>
        <h4>{providerNames[run.provider]} / {run.trialCount} 試行</h4>
        <p>Source SHA: <code>{run.sourceSha}</code></p>
        <p>記録期間（UTC）: {run.firstRecordedAt} ～ {run.lastRecordedAt}</p>
        <p>凍結（UTC）: {run.frozenAt} / seed {run.seed} / {run.repetitions} 反復</p>
      </li>)}</ul>
      <details><summary>共通の実験入力ハッシュ</summary><dl className="metric-list">
        <div><dt>instruction SHA-256</dt><dd>{comparison.instructionSha256}</dd></div>
        <div><dt>lockfile SHA-256</dt><dd>{comparison.lockfileSha256}</dd></div>
      </dl></details>
    </> : <p>単独の記録です。検証済みの方式間比較はありません。</p>}
    <p>{dataset.label} / Schema v{dataset.schemaVersion}</p>
    <p>生成: {dataset.generatedAt ?? "未生成"} / Source SHA: {dataset.sourceSha ?? (comparison ? "複数コミット — 方式別の出典を参照" : "未記録")}</p>
  </section>;
}

export function RecordArchive({ dataset }: { dataset: PublicDataset }) {
  const cases = [...new Set(dataset.trials.map((trial) => trial.caseId))];
  const [caseId, setCaseId] = useState(cases[0] ?? "");
  const [provider, setProvider] = useState("all");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const filtered = dataset.trials.map((trial, index) => ({ trial, index })).filter(({ trial }) => trial.caseId === caseId && (provider === "all" || trial.provider === provider));
  const selected = filtered.find(({ index }) => index === selectedIndex) ?? filtered[0];
  const summary = describeTrials(filtered.map(({ trial }) => trial));
  return <div className="archive-content">
    <div className="result-filters">
      <div><label htmlFor="case-select">ケース</label><select id="case-select" value={caseId} onChange={(event) => { setCaseId(event.target.value); setSelectedIndex(null); }}>{cases.map((id) => <option key={id} value={id}>{id} — {dataset.trials.find((trial) => trial.caseId === id)?.title}</option>)}</select></div>
      <div><label htmlFor="provider-select">方式</label><select id="provider-select" value={provider} onChange={(event) => { setProvider(event.target.value); setSelectedIndex(null); }}><option value="all">すべての方式</option>{Object.entries(providerNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
      <div><label htmlFor="trial-select">保存された試行</label><select id="trial-select" value={selected?.index ?? ""} onChange={(event) => setSelectedIndex(Number(event.target.value))} disabled={!filtered.length}>{filtered.length ? filtered.map(({ trial, index }) => <option key={index} value={index}>#{index + 1} · {providerNames[trial.provider]} · {trial.recordedAt} · {statusNames[trial.status]}</option>) : <option value="">記録なし</option>}</select></div>
    </div>
    <p className="descriptive-counts" aria-live="polite">選択条件内: {summary.total} 試行 / 修復案適用: {summary.repaired} / oracle・操作先とも PASS: {summary.verified} / {summary.evaluated} 検証済み / コスト小計: {formatCost(summary.costUsd)}（記録 {summary.measuredCosts} / {summary.total}）</p>
    <p className="muted">記述的な件数です。未検証 {summary.total - summary.evaluated} 試行は正否の分母から除外。反復・ケース構成を調整した比較ではありません。</p>
    {selected ? <TrialDetail trial={selected.trial} /> : <h3 role="status">この条件の記録はありません。</h3>}
  </div>;
}
