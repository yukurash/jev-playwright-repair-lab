import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import recorded from "../../../data/public/results.json";
import { comparisonFixture, datasetFixture, trialFixture } from "./test-fixtures";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = join(root, ".browser-test-output");
const servers: PreviewServer[] = [];
const urls: Record<string, string> = {};
let browser: Browser;

async function buildPreview(name: string, dataset: unknown): Promise<void> {
  const outDir = join(outputRoot, name);
  await build({
    root, logLevel: "silent", build: { outDir, emptyOutDir: true },
    plugins: [{
      name: "isolated-test-dataset", enforce: "pre",
      load(id) {
        if (id.replace(/\\/g, "/").endsWith("/data/public/results.json")) return JSON.stringify(dataset);
      },
    }],
  });
  const server = await preview({ root, logLevel: "silent", build: { outDir }, preview: { host: "127.0.0.1", port: 0, open: false } });
  servers.push(server);
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Preview did not start on a loopback port");
  urls[name] = `http://127.0.0.1:${address.port}/jev-playwright-repair-lab/`;
}

async function open(name: string, viewport = { width: 1440, height: 1000 }): Promise<Page> {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  await page.goto(urls[name]!);
  return page;
}

async function openArchive(page: Page) {
  await page.getByText(/^全 \d+ 件の記録を開く$/).click();
}

beforeAll(async () => {
  browser = await chromium.launch();
  const hostileHtml = `<main><h1>通知の設定</h1><script>parent.postMessage('executed','*')</script><button onclick="alert('unsafe')">変更を保存</button><img src="https://forbidden.example.test/image"><iframe src="https://forbidden.example.test/frame"></iframe><style>body{background:url('https://forbidden.example.test/css')}</style><a href="https://forbidden.example.test/">外部リンク</a><input autofocus onfocus="alert('unsafe')" value="&quot;&gt;&lt;script&gt;unsafe&lt;/script&gt;"></main>`;
  await buildPreview("empty", datasetFixture());
  await buildPreview("partial", datasetFixture([
    trialFixture({ afterHtml: hostileHtml }),
    trialFixture({ provider: "jev", model: "test-jev", route: "openrouter", status: "abstained", decision: "ABSTAIN", repairedTest: undefined, originalTestPassed: null, oraclePassed: null, targetCorrect: null, confidence: 0.7, recordedAt: "2026-01-01T00:01:00.000Z" }),
    trialFixture({ caseId: "test-other", title: "別ケース", provider: "azure", inference: "live", usage: { inputTokens: 120, outputTokens: 5 }, costUsd: 0.002, oraclePassed: true, targetCorrect: true }),
    trialFixture({ caseId: "test-guard", title: "モデル未呼び出し", provider: "azure", model: "not-invoked", status: "unsupported", decision: null, expectedDecision: null, repairable: false, repairedTest: undefined, originalTestPassed: false, oraclePassed: null, targetCorrect: null, latency: { captureMs: 10, decisionMs: 0, validationMs: 0, totalMs: 10 } }),
  ]));
  await buildPreview("invalid", { ...datasetFixture(), schemaVersion: 99 });
  await buildPreview("recorded", recorded);
  await buildPreview("invalid-comparison", { ...comparisonFixture(), comparison: undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))));
  await rm(outputRoot, { recursive: true, force: true });
});

describe("Jev switchboard", () => {
  it("puts a meaningful working decision switch in the first viewport, not the audit console", async () => {
    const page = await open("recorded", { width: 1440, height: 900 });
    try {
      await browserExpect(page.getByRole("heading", { level: 1 })).toContainText("Jevに任せたら");
      const bench = page.getByLabel("判断役を差し替える実測デモ");
      const box = await bench.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      await browserExpect(bench).toContainText("バックアップを作りたい");
      await browserExpect(bench).toContainText("切り替えても API は呼びません");
      await browserExpect(page.getByRole("group", { name: "判断役", exact: true })).toBeInViewport();
      await browserExpect(page.getByLabel("保存された試行")).toHaveCount(0);
      await browserExpect(page.getByRole("region", { name: "比較の条件と出典" })).not.toBeVisible();
      expect(await page.locator("iframe").count()).toBe(0);
    } finally { await page.close(); }
  });

  it("switches actual recorded decisions with keyboard support and preserves a shareable selection", async () => {
    const page = await open("recorded");
    try {
      const switches = page.getByRole("group", { name: "判断役", exact: true });
      await browserExpect(switches.getByRole("button", { name: "Jev", exact: true })).toHaveAttribute("aria-pressed", "true");
      await browserExpect(page.locator(".decision-receipt")).toContainText("Create recovery copy");
      await browserExpect(page.locator(".trial-mini-metrics")).toContainText("248.92 ms");
      const gpt = switches.getByRole("button", { name: "GPT-5.5" });
      await gpt.focus(); await page.keyboard.press("Enter");
      await browserExpect(gpt).toHaveAttribute("aria-pressed", "true");
      await browserExpect(page.locator(".decision-receipt")).toContainText("Create recovery copy");
      await browserExpect(page.locator(".trial-mini-metrics")).toContainText("3.64 秒");
      expect(new URL(page.url()).searchParams.get("model")).toBe("azure");
      await page.reload();
      await browserExpect(gpt).toHaveAttribute("aria-pressed", "true");
      await switches.getByRole("button", { name: "ルール" }).click();
      await browserExpect(page.locator(".decision-receipt")).toContainText("判断を保留");
      await browserExpect(page.locator(".candidate-choice.selected")).toHaveCount(0);
      await page.getByText("実際のコード差分を見る", { exact: false }).click();
      await browserExpect(page.getByText("修復後コードは未記録です。元のコードで補完しません。")).toBeVisible();
      await switches.getByRole("button", { name: "Jev", exact: true }).click();
      await browserExpect(page.getByLabel("修復後のテストコード")).toContainText("Create recovery copy");
      await browserExpect(page.getByLabel("修復後のテストコード")).toContainText('toHaveText("Backup created")');
    } finally { await page.close(); }
  });

  it("shows the selected answer in the first mobile viewport, not just the controls", async () => {
    const page = await open("recorded", { width: 390, height: 844 });
    try {
      const answer = await page.locator(".decision-receipt").boundingBox();
      expect(answer).not.toBeNull();
      expect(answer!.y + answer!.height).toBeLessThanOrEqual(844);
      await browserExpect(page.getByRole("group", { name: "判断役", exact: true })).toBeInViewport();
    } finally { await page.close(); }
  });

  it("displays accurate aggregates separately from the selected trial and never rounds rules to zero", async () => {
    const page = await open("recorded");
    try {
      const numbers = page.locator("#numbers");
      await browserExpect(numbers.locator(".azure .big-number")).toHaveText("48 / 48");
      await browserExpect(numbers.locator(".jev .big-number")).toHaveText("48 / 48");
      await browserExpect(numbers.locator(".rule .big-number")).toHaveText("30 / 48");
      await browserExpect(numbers).toContainText("全108試行の成功ではありません");
      await numbers.getByRole("button", { name: "どのくらい待つ？" }).click();
      await browserExpect(numbers.locator(".azure .big-number")).toHaveText("3.81 秒");
      await browserExpect(numbers.locator(".jev .big-number")).toHaveText("275.19 ms");
      await browserExpect(numbers.locator(".rule .big-number")).toHaveText("0.16 ms");
      await browserExpect(numbers.locator(".metric-card.jev")).toContainText("全工程の中央値: 1.93 秒");
      await numbers.getByRole("button", { name: "いくらかかった？" }).click();
      await browserExpect(numbers.locator(".azure .big-number")).toHaveText("$0.284355");
      await browserExpect(numbers.locator(".jev .big-number")).toHaveText("$0.00191709");
      await browserExpect(numbers.locator(".rule .big-number")).toHaveText("$0.00");
      await browserExpect(numbers.locator(".comparison-caveat")).toContainText("別時刻・別経路");
      await browserExpect(numbers).toContainText("購入手数料・税は含みません");
    } finally { await page.close(); }
  });

  it("reveals the second story without crediting either model for the code's rejection", async () => {
    const page = await open("recorded");
    try {
      const boundary = page.locator(".boundary-section");
      await browserExpect(boundary.locator(".boundary-body")).not.toBeVisible();
      await boundary.getByText("その裏側を見る", { exact: true }).click();
      for (const provider of ["Jev", "GPT-5.5"]) {
        await boundary.getByRole("button", { name: provider, exact: true }).click();
        await browserExpect(boundary.locator(".outcome").filter({ hasText: "元のアサーション" })).toContainText("PASS");
        await browserExpect(boundary.locator(".outcome").filter({ hasText: "独立 oracle" })).toContainText("FAIL");
        await browserExpect(boundary.locator(".outcome").filter({ hasText: "操作先" })).toContainText("PASS");
      }
      await browserExpect(boundary).toContainText("不具合を止めたのは、モデルではなく検証コード");
      await browserExpect(boundary).toContainText("GPT-5.5で9試行、Jevで9試行");
    } finally { await page.close(); }
  });

  it("retains all 324 records and complete provenance behind explicit disclosure controls", async () => {
    const page = await open("recorded");
    try {
      await openArchive(page);
      await browserExpect(page.getByLabel("ケース", { exact: true }).locator("option")).toHaveCount(36);
      await browserExpect(page.getByLabel("保存された試行").locator("option")).toHaveCount(9);
      await browserExpect(page.getByRole("region", { name: "データ収集状況" })).toContainText("324 件");
      await browserExpect(page.getByRole("region", { name: "データ収集状況" })).toContainText("API方式の試行 180 件");
      for (const provider of ["azure", "jev", "rule"]) {
        await page.getByLabel("方式", { exact: true }).selectOption(provider);
        await browserExpect(page.getByLabel("保存された試行").locator("option")).toHaveCount(3);
      }
      await page.getByText("比較条件・ソース・ハッシュ", { exact: true }).click();
      const provenance = page.getByRole("region", { name: "比較の条件と出典" });
      await browserExpect(provenance).toContainText("方式間のランダム化・交互実行はしていません");
      await browserExpect(provenance.locator(".provenance-runs li")).toHaveCount(3);
      await browserExpect(provenance).toContainText("821a056ac8459a4ee4e3daa35cc9665bb9ebba42");
      await browserExpect(provenance).toContainText("ca01954b0e43e624a063cdca127300b56b21efa0");
      await provenance.getByText("共通の実験入力ハッシュ").click();
      await browserExpect(provenance).toContainText(recorded.comparison.instructionSha256);
      await browserExpect(provenance).toContainText("複数コミット");
      await openArchive(page);
      await browserExpect(page.getByLabel("保存された試行")).toHaveCount(0);
    } finally { await page.close(); }
  });

  it("preserves unknowns, no-call guards, partial releases and filter misses without inventing a story", async () => {
    const page = await open("partial");
    try {
      expect(await page.locator(".decision-bench").count()).toBe(0);
      expect(await page.locator(".metric-cards").count()).toBe(0);
      await browserExpect(page.getByRole("heading", { name: "GPT-5.5のみ実測" })).toBeVisible();
      await openArchive(page);
      await browserExpect(page.getByLabel("保存された試行").locator("option")).toHaveCount(2);
      await browserExpect(page.locator(".descriptive-counts")).toContainText("0 / 1 検証済み");
      await browserExpect(page.locator(".metric-list > div").filter({ hasText: "記録済みコスト" })).toContainText("未記録");
      await page.getByLabel("保存された試行").selectOption("1");
      await browserExpect(page.getByText("接続経路: OpenRouter。", { exact: false })).toBeVisible();
      await browserExpect(page.getByText("修復後コードは未記録です。元のコードで補完しません。")).toBeVisible();
      await page.getByLabel("方式", { exact: true }).selectOption("azure");
      await browserExpect(page.getByRole("status")).toContainText("この条件の記録はありません");
      await page.getByLabel("ケース", { exact: true }).selectOption("test-guard");
      await browserExpect(page.locator(".record-meta")).toContainText("決定論的実行の保存記録");
      await browserExpect(page.locator(".metric-list > div").filter({ hasText: "記録済みコスト" })).toContainText("未記録");
    } finally { await page.close(); }
  });

  it("does not fetch third-party resources or execute scripts from recorded snapshots", async () => {
    const page = await browser.newPage();
    const externalRequests: string[] = [];
    const errors: string[] = [];
    const origin = new URL(urls.partial!).origin;
    page.on("request", (request) => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      addEventListener("message", (event) => { if (event.data === "executed") document.documentElement.setAttribute("data-executed", "yes"); });
    });
    try {
      await page.goto(urls.partial!);
      await openArchive(page);
      await page.getByText("変更前後の画面と HTML", { exact: true }).click();
      const frames = page.locator(".snapshot iframe");
      await browserExpect(frames).toHaveCount(2);
      for (const frame of await frames.all()) {
        await browserExpect(frame).toHaveAttribute("sandbox", "");
        expect(await frame.getAttribute("srcdoc")).not.toMatch(/<script|onclick|onfocus|https:\/\/forbidden|<iframe|<img|autofocus/);
      }
      await browserExpect(page.frameLocator('iframe[title="AFTER 静的画面"]').getByRole("heading", { name: "通知の設定" })).toBeVisible();
      await page.getByText("記録された HTML を読む", { exact: true }).last().click();
      await browserExpect(page.locator(".source-detail").last()).toContainText("<script>parent.postMessage");
      expect(await page.locator("html").getAttribute("data-executed")).not.toBe("yes");
      expect(externalRequests).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it("keeps empty data explicit, defaults dark and persists the chosen light theme", async () => {
    const page = await open("empty");
    try {
      await browserExpect(page.getByRole("heading", { name: "未収集", exact: true })).toBeVisible();
      await browserExpect(page.getByText("説明用の成功結果や性能値は作りません。", { exact: false })).toBeVisible();
      expect(await page.locator("input, .metric-cards, .decision-bench").count()).toBe(0);
      expect(await page.locator('a[href="#numbers"]').count()).toBe(0);
      expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
      await page.getByRole("button", { name: "ライトモードに切り替える" }).click();
      await page.reload();
      expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
    } finally { await page.close(); }
  });

  it("has no horizontal page overflow, including open records and costs at 320px", async () => {
    for (const width of [320, 390, 768, 1440]) {
      const page = await open("recorded", { width, height: 900 });
      try {
        const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
        expect(await fits(), `initial width ${width}`).toBe(true);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
        await page.getByRole("button", { name: "いくらかかった？" }).click();
        await page.getByText("その裏側を見る", { exact: true }).click();
        await openArchive(page);
        await page.getByText("比較条件・ソース・ハッシュ", { exact: true }).click();
        expect(await fits(), `expanded width ${width}`).toBe(true);
        await page.getByRole("button", { name: "ライトモードに切り替える" }).click();
        expect(await fits(), `light width ${width}`).toBe(true);
      } finally { await page.close(); }
    }
  });

  it("keeps text and state colors at AA contrast in both themes", async () => {
    const page = await open("recorded");
    try {
      for (const theme of ["dark", "light"]) {
        await browserExpect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const tokens = await page.evaluate(() => {
          const styles = getComputedStyle(document.documentElement);
          return Object.fromEntries(["ink", "muted", "page", "surface", "accent", "accent-soft", "positive", "positive-bg", "negative", "negative-bg", "warning", "warning-bg", "paper", "paper-ink", "paper-muted"].map((name) => [name, styles.getPropertyValue(`--${name}`).trim()]));
        });
        function luminance(hex: string): number {
          const channels = hex.slice(1).match(/.{2}/g)!.map((pair) => {
            const channel = parseInt(pair, 16) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
        }
        for (const [text, background] of [["ink", "page"], ["muted", "surface"], ["accent", "accent-soft"], ["positive", "positive-bg"], ["negative", "negative-bg"], ["warning", "warning-bg"], ["paper-ink", "paper"], ["paper-muted", "paper"]]) {
          const levels = [luminance(tokens[text!]!), luminance(tokens[background!]!)].sort((a, b) => a - b);
          expect((levels[1]! + 0.05) / (levels[0]! + 0.05), `${theme}: ${text}/${background}`).toBeGreaterThanOrEqual(4.5);
        }
        if (theme === "dark") await page.getByRole("button", { name: "ライトモードに切り替える" }).click();
      }
    } finally { await page.close(); }
  });

  it.each([["invalid", "schemaVersion"], ["invalid-comparison", "sourceSha"]])("fails closed for %s", async (name, field) => {
    const page = await open(name);
    try {
      await browserExpect(page.getByRole("alert")).toContainText(field);
      await browserExpect(page.getByRole("heading", { name: "公開データを表示できません。" })).toBeVisible();
      expect(await page.locator(".decision-bench, .metric-cards").count()).toBe(0);
    } finally { await page.close(); }
  });
});
