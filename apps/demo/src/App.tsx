import { useEffect, useState } from "react";
import type { ProviderId, PublicDataset } from "../../../packages/core/src/index";
import { summarize } from "../../../packages/experiment/src/summary";
import { formatCost, formatDuration } from "./data";
import { candidateName, CodeDiff, ComparisonProvenance, Outcome, RecordArchive } from "./RecordArchive";

const repository = "https://github.com/yukurash/jev-playwright-repair-lab";
const names = { azure: "GPT-5.5", jev: "Jev", rule: "ルール" } as const;
const providers = ["azure", "jev", "rule"] as const;

function Header({ storyReady }: { storyReady: boolean }) {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem("repair-lab-theme") !== "light"; }
    catch { return true; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#181a17" : "#f3f1e7");
    try { localStorage.setItem("repair-lab-theme", dark ? "dark" : "light"); }
    catch { /* Theme persistence is optional when browser storage is disabled. */ }
  }, [dark]);
  return <header className="site-header">
    <a href="#main" className="brand" aria-label="Jev Switchboard ホーム"><span className="brand-mark" aria-hidden="true">j/</span>JEV<span className="brand-sub">SWITCHBOARD</span></a>
    <nav aria-label="メインナビゲーション">
      <a href={storyReady ? "#numbers" : "#archive"}>{storyReady ? "実測を見る" : "記録を見る"}</a><a href="#archive">全記録</a><a href={repository} target="_blank" rel="noreferrer">GitHub ↗</a>
      <button type="button" className="theme-toggle" onClick={() => setDark(!dark)} aria-label={dark ? "ライトモードに切り替える" : "ダークモードに切り替える"}>{dark ? "☼" : "◐"}</button>
    </nav>
  </header>;
}

function ProviderSwitch({ value, onChange, label }: { value: ProviderId; onChange: (value: ProviderId) => void; label: string }) {
  return <div className="provider-switch" role="group" aria-label={label}>
    {providers.map((provider) =>
      <button key={provider} type="button" aria-pressed={value === provider} onClick={() => onChange(provider)}><span className={`provider-dot ${provider}`} aria-hidden="true" />{names[provider]}</button>)}
  </div>;
}

function readStoryProvider(): ProviderId {
  const provider = new URLSearchParams(location.search).get("model");
  return provider === "azure" || provider === "rule" ? provider : "jev";
}

function firstTrial(dataset: PublicDataset, caseId: string, provider: ProviderId) {
  return dataset.trials.find((trial) => trial.caseId === caseId && trial.provider === provider && trial.split === "final");
}

function DecisionBench({ dataset }: { dataset: PublicDataset }) {
  const [provider, setProvider] = useState(readStoryProvider);
  const trial = firstTrial(dataset, "backup-create-a", provider);
  const common = firstTrial(dataset, "backup-create-a", "jev");
  useEffect(() => {
    const restore = () => setProvider(readStoryProvider());
    addEventListener("popstate", restore);
    return () => removeEventListener("popstate", restore);
  }, []);
  function select(value: ProviderId) {
    setProvider(value);
    const url = new URL(location.href);
    url.searchParams.set("model", value);
    history.replaceState(null, "", url);
  }
  if (!common) return null;
  const selected = trial?.candidates.find((candidate) => candidate.id === trial.decision);
  return <div className="decision-bench" aria-label="判断役を差し替える実測デモ">
    <div className="bench-caption"><span>01 / THE SWITCH</span><span className="record-indicator">保存済みの実測</span></div>
    <div className="task-ticket"><span className="ticket-label">依頼は、ひとつ。</span><h2>バックアップを作りたい。</h2><p>でも、元のボタン名は変わってしまった。</p><code><s>Back up now</s><span aria-hidden="true"> → </span> ?</code></div>
    <div className="switch-row"><span>判断役を差し替える <span aria-hidden="true">↓</span></span><ProviderSwitch value={provider} onChange={select} label="判断役" /></div>
    <div className="decision-output" aria-live="polite" aria-atomic="true">
      <div className="candidate-choices">{common.candidates.map((candidate, index) => <div className={`candidate-choice ${trial?.decision === candidate.id ? "selected" : ""}`} key={candidate.id}>
        <span className="option-letter" aria-hidden="true">{index === 0 ? "A" : "B"}</span><div><strong>{candidateName(candidate)}</strong><span>{candidate.id === "c1" ? "復元用コピーから戻す" : "復元用コピーを作る"}</span></div>
        {trial?.decision === candidate.id && <span className="choice-check" aria-label="選択">✓</span>}
      </div>)}</div>
      <div className="decision-receipt">
        <div><span>{names[provider]}の回答</span><strong>{trial ? selected ? `「${candidateName(selected)}」` : trial.decision === "ABSTAIN" ? "判断を保留" : trial.decision ?? "回答なし" : "記録なし"}</strong></div>
        <span className={`receipt-stamp ${selected ? "" : "neutral"}`}>{selected ? "SELECTED" : "ABSTAIN"}</span>
      </div>
      <div className="trial-mini-metrics"><span>この1試行の判断時間<strong>{formatDuration(trial?.latency.decisionMs ?? null)}</strong></span><span>この1試行の費用<strong>{formatCost(trial?.costUsd)}</strong></span></div>
    </div>
    <p className="bench-note">各方式の最初の反復・別時刻／別経路。画面は説明用に再構成。切り替えても API は呼びません。</p>
    {trial && <details className="bench-diff"><summary>実際のコード差分を見る <span aria-hidden="true">↗</span></summary><CodeDiff original={trial.originalTest} repaired={trial.repairedTest} /><p className="muted">{trial.caseId} / {trial.recordedAt} / {trial.model}</p></details>}
  </div>;
}

function Metrics({ dataset }: { dataset: PublicDataset }) {
  const [metric, setMetric] = useState<"repair" | "time" | "cost">("repair");
  const rows = summarize(dataset.trials);
  const repairable = dataset.trials.filter((trial) => trial.provider === "jev" && trial.repairable);
  const jev = rows.find((row) => row.provider === "jev")!;
  const labels = { repair: "修復できた？", time: "どのくらい待つ？", cost: "いくらかかった？" };
  const titles = { repair: "この「選ぶ」は、任せられた。", time: "判断は短く。ブラウザの仕事は残る。", cost: "小さな判断に、大きなモデルは必要？" };
  return <section id="numbers" className="numbers-section" aria-labelledby="numbers-title">
    <div className="section-intro"><p className="eyebrow">02 / THE EVIDENCE</p><h2 id="numbers-title">で、差し替えてどうだった？</h2><p>{dataset.trials.length} 試行の記録で確かめる。</p></div>
    <div className="metric-tabs" role="group" aria-label="比較する指標">{(Object.keys(labels) as (keyof typeof labels)[]).map((key) => <button type="button" key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{labels[key]}</button>)}</div>
    <div className="metric-display" aria-live="polite">
      <h3>{titles[metric]}</h3>
      <div className="metric-cards">{providers.map((provider) => {
        const row = rows.find((entry) => entry.provider === provider)!;
        return <article className={`metric-card ${provider}`} key={provider}>
          <h4><span className={`provider-dot ${provider}`} />{names[provider]}</h4>
          <p className={`big-number ${metric}`}>{metric === "repair" ? <>{row.correctRepairs}<span> / {row.repairableTrials}</span></> : metric === "time" ? formatDuration(row.decisionLatencyP50Ms) : formatCost(row.observedCostUsd)}</p>
          <p>{metric === "repair" ? "正しく修復 / 修復可能な試行" : metric === "time" ? `判断時間の中央値 / ${row.decisions} 件` : `最終評価の合計 / 料金記録 ${row.costObservations} 件`}</p>
          {metric === "repair" && <div className="repair-track" aria-hidden="true"><span style={{ width: `${(row.correctRepairRate ?? 0) * 100}%` }} /></div>}
          {metric === "time" && <small>全工程の中央値: {formatDuration(row.totalLatencyP50Ms)}</small>}
          {metric === "cost" && <small>{provider === "azure" ? "Azure usage からの料金見積もり" : provider === "jev" ? "OpenRouter が報告した料金" : "モデル API を呼ばない処理"}</small>}
        </article>;
      })}</div>
      <p className="metric-context">{metric === "repair" ? `${jev.correctRepairs}/${jev.repairableTrials} は全${jev.trials}試行の成功ではありません。${new Set(repairable.map((trial) => trial.familyId)).size}家族・${new Set(repairable.map((trial) => trial.caseId)).size}変種を各${dataset.comparison?.repetitions}反復した、自作ケースの修復可能な部分です。` : metric === "time" ? "表示は実測値の集計です。レースや待ち時間の再現ではありません。コードのガードでモデルを呼ばなかった試行は除外。" : "最終評価のみ。準備・接続失敗・購入手数料・税は含みません。モデル未呼び出しガードの料金欄は欠損のまま、観測値だけを合計しています。"}</p>
    </div>
    <p className="comparison-caveat"><span aria-hidden="true">↳</span> 別時刻・別経路の測定です（Azure / OpenRouter）。小規模な自作ケースの結果で、モデル単体の速度・優劣を保証しません。<a href={`${repository}/blob/main/docs/comparison-results.md`}>測定条件を読む ↗</a></p>
  </section>;
}

function Boundary({ dataset }: { dataset: PublicDataset }) {
  const gpt = firstTrial(dataset, "email-not-sent-a", "azure");
  const jev = firstTrial(dataset, "email-not-sent-a", "jev");
  if (!gpt || !jev) return null;
  const sameResult = (["decision", "targetCorrect", "originalTestPassed", "oraclePassed"] as const)
    .every((field) => gpt[field] === jev[field]);
  const greenCounts = summarize(dataset.trials).filter((row) => row.provider !== "rule");
  return <section className="boundary-section" aria-labelledby="boundary-title">
    <div className="boundary-copy"><p className="eyebrow">03 / THE SHARED LIMIT</p><h2 id="boundary-title">どちらを使っても、<br />検証は必要。</h2><p>操作先を選ぶことと、<br />実際にメールが送られたかを確かめることは別。</p><span className="boundary-label">ここは優劣ではなく、共通の限界。</span></div>
    <details className="boundary-card"><summary><span className="test-green">✓ TEST PASSED</span><strong>その裏側を見る</strong><span className="fold-plus" aria-hidden="true">＋</span></summary>
      <div className="boundary-body">
        <p className="shared-result-label">{sameResult ? "GPT-5.5・Jevともに同じ結果" : "GPT-5.5・Jevの保存された結果"}</p>
        {(sameResult ? [gpt] : [gpt, jev]).map((trial) => {
          const selected = trial.candidates.find((candidate) => candidate.id === trial.decision);
          return <div className="boundary-result" key={trial.provider}>
            <p className="boundary-selected">{sameResult ? "両モデルが選んだ操作先" : names[trial.provider]} → <strong>{selected ? candidateName(selected) : trial.decision ?? "未記録"}</strong></p>
            <Outcome label="操作先の正しさ" value={trial.targetCorrect} /><Outcome label="元のアサーション" value={trial.originalTestPassed} /><Outcome label="独立 oracle の状態検証" value={trial.oraclePassed} />
          </div>;
        })}
        <p><strong>業務結果まで確かめるのは、モデルではなく検証コード。</strong><br />正しい操作先・元テストPASSでも業務状態が誤っていた結果は{greenCounts.map((row) => `${names[row.provider]}で${row.rightTargetRegressionGreen}試行`).join("、")}でした。</p>
        <p className="muted">email-not-sent-a / 各方式の最初の反復。自作の独立検証であり、本番で自動的に手に入る正解判定器ではありません。</p>
      </div>
    </details>
  </section>;
}

function CollectionStatus({ dataset }: { dataset: PublicDataset }) {
  const live = dataset.trials.filter((trial) => trial.inference === "live").length;
  const measured = (["azure", "jev"] as const).filter((provider) => dataset.trials.some((trial) => trial.provider === provider && trial.inference === "live" && trial.decision !== null && trial.usage));
  const pending = (["azure", "jev"] as const).filter((provider) => !measured.includes(provider));
  return <section className="collection-status" aria-label="データ収集状況">
    <h3>{!dataset.trials.length ? "未収集" : measured.length === 1 ? `${names[measured[0]!]}のみ実測` : measured.length === 2 ? "記録を公開中" : "API 実測は未収集"}</h3>
    <p>{dataset.trials.length} 件の保存済み試行。API方式の試行 {live} 件 / 決定論的実行（ガードを含む）{dataset.trials.length - live} 件。</p>
    {pending.length > 0 && <p>{pending.map((provider) => names[provider]).join("・")}は未実測です。方式間の優劣はまだ比較できません。</p>}
  </section>;
}

export function DataError({ message }: { message: string }) {
  return <main className="data-error"><p className="eyebrow">DATA VALIDATION ERROR</p><h1>公開データを表示できません。</h1><p role="alert">{message}</p><p>壊れた記録を空の結果や成功値として表示しません。</p><a href={repository}>リポジトリを確認する ↗</a></main>;
}

export function App({ dataset }: { dataset: PublicDataset }) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const storyReady = Boolean(dataset.comparison && providers.every((provider) =>
    firstTrial(dataset, "backup-create-a", provider) && firstTrial(dataset, "email-not-sent-a", provider)));
  return <>
    <a href="#main" className="skip-link">本文へスキップ</a>
    <div className="site-shell"><Header storyReady={storyReady} />
      <main id="main">
        <section className="hero">
          <div className="hero-copy"><p className="eyebrow"><span className="tiny-cross" aria-hidden="true">✳</span> A SMALL JOB FOR AI</p>
            <h1>その<span className="outlined-word">「選ぶ」</span>、<br /><span className="accent-word">Jev</span>に任せたら<span className="end-dot">。</span></h1>
            <p className="hero-description">文章をつくる代わりに、候補からひとつ選ぶ。<br />テスト修復の判断役を、GPTからJevへ。</p>
            <div className="role-strip"><span>コードで候補を作る</span><span className="role-active">Jevが選ぶ</span><span>コードで直す・検証</span></div>
            <p className="hero-footnote">Playwright のロケータ修復で試した、<br />「LLMを全部置き換えない」使い方。</p>
            <a href={storyReady ? "#numbers" : "#archive"} className="text-link">{storyReady ? "実験でわかったこと" : "保存済みの記録を見る"} <span aria-hidden="true">↓</span></a>
          </div>
          {storyReady ? <DecisionBench dataset={dataset} /> : <div className="no-story"><p className="eyebrow">RECORDED DATA ONLY</p><h2>比較の記録を準備中。</h2><p>説明用の成功結果や性能値は作りません。保存されている記録は下の一覧で確認できます。</p><CollectionStatus dataset={dataset} /></div>}
        </section>
        {storyReady && <><Metrics dataset={dataset} /><Boundary dataset={dataset} /></>}
        <section className="takeaway"><span className="takeaway-symbol" aria-hidden="true">↳</span><div><p className="eyebrow">THE TAKEAWAY</p><h2>何でも書かせる、から。<br />必要な判断だけ、任せる。</h2><p>候補はコードで絞る。意味で選ぶところはJevへ。<br />変更する権限と、結果の検証は手放さない。</p></div><a className="button-link" href={`${repository}#local-workflow`} target="_blank" rel="noreferrer">自分のコードで試す ↗</a></section>
        <section id="archive" className="archive-section" aria-labelledby="archive-title">
          <div className="archive-heading"><div><p className="eyebrow">OPEN NOTEBOOK</p><h2 id="archive-title">裏取りしたい人へ。</h2></div><span>成功だけでなく、保留・却下も。</span></div>
          <details className="archive-fold" onToggle={(event) => setArchiveOpen(event.currentTarget.open)}><summary><span>全 {dataset.trials.length} 件の記録を開く</span><span className="fold-plus" aria-hidden="true">＋</span></summary>
            {archiveOpen && <><CollectionStatus dataset={dataset} />{dataset.trials.length > 0 && <RecordArchive dataset={dataset} />}</>}
          </details>
          <details className="archive-fold"><summary><span>比較条件・ソース・ハッシュ</span><span className="fold-plus" aria-hidden="true">＋</span></summary><ComparisonProvenance dataset={dataset} /></details>
          <div className="archive-links"><a href={`${repository}/blob/main/docs/comparison-results.md`}>比較レポート ↗</a><a href={`${repository}/blob/main/data/public/results.json`}>全データ JSON ↗</a><a href="https://openrouter.ai/docs/guides/community/jev">Jevとは / 公式ガイド ↗</a></div>
        </section>
      </main>
      <footer><a className="brand" href="#main">j/ <span>JEV SWITCHBOARD</span></a><p>2026 / REPAIR LAB<br />記録の再生のみ。ライブ推論・課金なし。</p><a href={`${repository}/blob/main/LICENSE`}>MIT License ↗</a></footer>
    </div>
  </>;
}
