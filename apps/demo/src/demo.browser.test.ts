import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { datasetFixture, trialFixture } from "./test-fixtures";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = join(root, ".browser-test-output");
const servers: PreviewServer[] = [];
const urls: Record<string, string> = {};
let browser: Browser;

async function buildPreview(name: string, dataset: unknown): Promise<void> {
  const outDir = join(outputRoot, name);
  await build({
    root,
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
    plugins: [{
      name: "isolated-test-dataset",
      enforce: "pre",
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

beforeAll(async () => {
  browser = await chromium.launch();
  const hostileHtml = `<main><h1>通知の設定</h1><script>parent.postMessage('executed','*')</script><button onclick="alert('unsafe')">変更を保存</button><img src="https://forbidden.example.test/image"><iframe src="https://forbidden.example.test/frame"></iframe><style>body{background:url('https://forbidden.example.test/css')}</style><a href="https://forbidden.example.test/">外部リンク</a><input autofocus onfocus="alert('unsafe')" value="&quot;&gt;&lt;script&gt;unsafe&lt;/script&gt;"></main>`;
  await buildPreview("empty", datasetFixture());
  await buildPreview("recorded", datasetFixture([
    trialFixture({ afterHtml: hostileHtml }),
    trialFixture({ provider: "jev", model: "test-jev", status: "abstained", decision: "ABSTAIN", repairedTest: undefined, originalTestPassed: null, oraclePassed: null, targetCorrect: null, confidence: 0.7, recordedAt: "2026-01-01T00:01:00.000Z" }),
    trialFixture({ caseId: "test-other", title: "別ケース", provider: "azure", inference: "live", usage: { inputTokens: 120, outputTokens: 5 }, costUsd: 0.002, oraclePassed: true, targetCorrect: true }),
    trialFixture({ caseId: "test-guard", title: "モデル未呼び出し", provider: "azure", model: "not-invoked", status: "unsupported", decision: null, expectedDecision: null, repairable: false, repairedTest: undefined, originalTestPassed: false, oraclePassed: null, targetCorrect: null, latency: { captureMs: 10, decisionMs: 0, validationMs: 0, totalMs: 10 } }),
  ]));
  await buildPreview("invalid", { ...datasetFixture(), schemaVersion: 99 });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))));
  await rm(outputRoot, { recursive: true, force: true });
});

describe("recorded-only comparison demo", () => {
  it("honestly labels the empty state and supports keyboard walkthrough and theme toggling", async () => {
    const page = await open("empty");
    try {
      await browserExpect(page.getByRole("heading", { name: "未収集", exact: true })).toBeVisible();
      await browserExpect(page.getByText("説明用・実測ではありません", { exact: true })).toBeVisible();
      expect(await page.locator("input").count()).toBe(0);
      const step = page.getByRole("button", { name: "02 候補から選ぶ" });
      await step.focus();
      await page.keyboard.press("Enter");
      await browserExpect(step).toHaveAttribute("aria-pressed", "true");
      await browserExpect(page.getByRole("heading", { name: "書き直すのは、ロケータだけ。" })).toBeVisible();
      await page.getByRole("button", { name: "03 正しさを確かめる" }).click();
      await browserExpect(page.getByRole("heading", { name: "緑のテストと、正しい操作は別。" })).toBeVisible();
      const initialTheme = await page.locator("html").getAttribute("data-theme");
      expect(initialTheme).toBe("dark");
      await page.getByRole("button", { name: /モードに切り替える/ }).click();
      expect(await page.locator("html").getAttribute("data-theme")).not.toBe(initialTheme);
      await page.reload();
      expect(await page.locator("html").getAttribute("data-theme")).not.toBe(initialTheme);
    } finally { await page.close(); }
  });

  it("keeps the actual workbench above the fold rather than a decorative hero", async () => {
    const page = await open("empty", { width: 1440, height: 900 });
    try {
      for (const selector of [".case-list", ".example-editor", ".inspector-heading"]) {
        const box = await page.locator(selector).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThan(900);
      }
      const sidebar = await page.locator(".case-sidebar").boundingBox();
      const editor = await page.locator(".editor-pane").boundingBox();
      const inspector = await page.locator(".inspector").boundingBox();
      expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(editor!.x + 1);
      expect(editor!.x + editor!.width).toBeLessThanOrEqual(inspector!.x + 1);
      await browserExpect(page.getByRole("button", { name: "差分", exact: true })).toHaveAttribute("aria-pressed", "true");
      await browserExpect(page.locator(".example-editor .added")).toHaveCount(1);
    } finally { await page.close(); }
  });

  it("switches illustrative cases and restores shareable state without inventing model results", async () => {
    const page = await open("empty");
    try {
      await page.getByRole("button", { name: /通ったのに、違う/ }).click();
      await page.getByRole("button", { name: "03 正しさを確かめる" }).click();
      const inspector = page.getByRole("complementary", { name: "独立検証の説明" });
      await browserExpect(inspector.locator(".outcome").filter({ hasText: "元のアサーション" })).toContainText("PASS");
      await browserExpect(inspector.locator(".outcome").filter({ hasText: "独立した状態検証" })).toContainText("FAIL");
      await browserExpect(inspector).toContainText("実際のモデルの応答ではありません");
      await browserExpect(page.locator(".sidebar-providers")).toContainText("未比較");
      await page.getByRole("button", { name: "画面", exact: true }).click();
      expect(new URL(page.url()).searchParams.get("example")).toBe("wrong-target");
      expect(new URL(page.url()).searchParams.get("step")).toBe("2");
      expect(new URL(page.url()).searchParams.get("view")).toBe("preview");
      await page.reload();
      await browserExpect(page.getByRole("button", { name: /通ったのに、違う/ })).toHaveAttribute("aria-pressed", "true");
      await browserExpect(page.frameLocator('iframe[title="AFTER 静的画面"]').getByRole("button", { name: "注文を確定" })).toBeVisible();
      await page.getByRole("button", { name: /修復しない判断/ }).click();
      await page.getByRole("button", { name: "差分", exact: true }).click();
      await browserExpect(page.locator(".stop-note")).toContainText("NO_REPAIR");
      await browserExpect(page.locator(".example-editor .added")).toHaveCount(0);
      await page.getByRole("button", { name: "最初から見る" }).click();
      await browserExpect(page.getByRole("button", { name: "01 失敗をとらえる" })).toHaveAttribute("aria-pressed", "true");
    } finally { await page.close(); }
  });

  it("shows every recorded trial, unknown metrics and assertion/oracle disagreement", async () => {
    const page = await open("recorded");
    try {
      await browserExpect(page.getByLabel("保存された試行").locator("option")).toHaveCount(2);
      await browserExpect(page.locator(".descriptive-counts")).toContainText("選択条件内: 2 試行");
      await browserExpect(page.locator(".descriptive-counts")).toContainText("0 / 1 検証済み");
      await browserExpect(page.locator(".outcome").filter({ hasText: "元のアサーション" })).toContainText("PASS");
      await browserExpect(page.locator(".outcome").filter({ hasText: "独立 oracle" })).toContainText("FAIL");
      await browserExpect(page.locator(".metric-list > div").filter({ hasText: "記録済みコスト" })).toContainText("未記録");
      await page.getByLabel("保存された試行").selectOption("1");
      await browserExpect(page.getByText("修復後コードは未記録です。元のコードで補完しません。")).toBeVisible();
      await browserExpect(page.getByText("confidence はモデルの自己申告で、正解率ではありません。", { exact: false })).toBeVisible();
      await page.getByLabel("方式", { exact: true }).selectOption("azure");
      await browserExpect(page.getByRole("heading", { name: "この条件の記録はありません。" })).toBeVisible();
      await page.getByLabel("ケース", { exact: true }).selectOption("test-other");
      await browserExpect(page.locator(".trial-title")).toContainText("別ケース");
      await browserExpect(page.locator(".metric-list")).toContainText(["$0.002", "a".repeat(40)]);
    } finally { await page.close(); }
  });

  it("uses sandboxed escaped snapshots and never loads source HTML URLs or scripts", async () => {
    const page = await browser.newPage();
    const externalRequests: string[] = [];
    const errors: string[] = [];
    const origin = new URL(urls.recorded!).origin;
    page.on("request", (request) => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      document.documentElement?.setAttribute("data-executed", "no");
      addEventListener("message", (event) => { if (event.data === "executed") document.documentElement.setAttribute("data-executed", "yes"); });
    });
    try {
      await page.goto(urls.recorded!);
      const frames = page.locator(".snapshot iframe");
      await browserExpect(frames).toHaveCount(2);
      for (const frame of await frames.all()) {
        await browserExpect(frame).toHaveAttribute("sandbox", "");
        const source = await frame.getAttribute("srcdoc");
        expect(source).not.toMatch(/<script|onclick|onfocus|https:\/\/forbidden|<iframe|<img|autofocus/);
      }
      await browserExpect(page.frameLocator('iframe[title="AFTER 静的画面"]').getByRole("heading", { name: "通知の設定" })).toBeVisible();
      await page.getByText("記録された HTML を読む", { exact: true }).last().click();
      await browserExpect(page.locator(".source-detail").last().locator("code")).toContainText("<script>parent.postMessage");
      expect(await page.locator("html").getAttribute("data-executed")).not.toBe("yes");
      expect(externalRequests).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it("labels a partial API release without attributing deterministic guards to a model", async () => {
    const page = await open("recorded");
    try {
      const status = page.getByRole("region", { name: "データ収集状況" });
      await browserExpect(status.getByRole("heading", { name: "GPT-5.5のみ実測" })).toBeVisible();
      await browserExpect(status).toContainText("Jevは未実測です。方式間の優劣はまだ比較できません。");
      await browserExpect(status).toContainText("4 件の保存済み試行。API方式の試行 1 件 / 決定論的実行（ガードを含む）3 件");
      await page.getByLabel("ケース", { exact: true }).selectOption("test-guard");
      await browserExpect(page.locator(".record-meta")).toContainText("決定論的実行の保存記録");
      await browserExpect(page.locator(".metric-list > div").filter({ hasText: "記録済みコスト" })).toContainText("未記録");
      await page.setViewportSize({ width: 320, height: 812 });
      await browserExpect(status).toBeVisible();
      await browserExpect(status).toContainText("Jevは未実測");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  });

  it("has no horizontal page overflow on narrow screens and respects reduced motion", async () => {
    for (const [name, width] of [["empty", 320], ["empty", 375], ["empty", 768], ["recorded", 320], ["recorded", 375], ["recorded", 768]] as const) {
      const page = await open(name, { width, height: 812 });
      try {
        await browserExpect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
        await page.getByRole("link", { name: "再現する", exact: true }).click();
        await browserExpect(page.getByRole("heading", { name: /ブラウザでは、読む。/ })).toBeVisible();
      } finally { await page.close(); }
    }
  });

  it("keeps small text and status colors readable in both themes", async () => {
    const page = await open("empty");
    try {
      for (const theme of ["dark", "light"]) {
        await browserExpect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const tokens = await page.evaluate(() => {
          const styles = getComputedStyle(document.documentElement);
          return Object.fromEntries(["ink", "muted", "page", "surface", "accent", "accent-soft", "positive", "positive-bg", "negative", "negative-bg", "warning", "warning-bg"].map((name) => [name, styles.getPropertyValue(`--${name}`).trim()]));
        });
        function luminance(hex: string): number {
          const value = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit.repeat(2)).join("") : hex.slice(1);
          const channels = value.match(/.{2}/g)!.map((pair) => {
            const channel = parseInt(pair, 16) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
        }
        for (const [text, background] of [["ink", "page"], ["muted", "surface"], ["accent", "accent-soft"], ["positive", "positive-bg"], ["negative", "negative-bg"], ["warning", "warning-bg"]]) {
          const levels = [luminance(tokens[text!]!), luminance(tokens[background!]!)].sort((a, b) => a - b);
          expect((levels[1]! + 0.05) / (levels[0]! + 0.05), `${theme}: ${text}/${background}`).toBeGreaterThanOrEqual(4.5);
        }
        if (theme === "dark") await page.getByRole("button", { name: "ライトモードに切り替える" }).click();
      }
    } finally { await page.close(); }
  });

  it("reports malformed data explicitly instead of silently presenting an empty benchmark", async () => {
    const page = await open("invalid");
    try {
      await browserExpect(page.getByRole("alert")).toContainText("schemaVersion");
      await browserExpect(page.getByRole("heading", { name: "公開データを表示できません。" })).toBeVisible();
      expect(await page.locator(".collection-status").count()).toBe(0);
    } finally { await page.close(); }
  });
});
