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
      await page.getByRole("button", { name: /モードに切り替える/ }).click();
      expect(await page.locator("html").getAttribute("data-theme")).not.toBe(initialTheme);
      await page.reload();
      expect(await page.locator("html").getAttribute("data-theme")).not.toBe(initialTheme);
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

  it("has no horizontal page overflow on narrow screens and respects reduced motion", async () => {
    for (const name of ["empty", "recorded"]) {
      const page = await open(name, { width: 375, height: 812 });
      try {
        await browserExpect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
        await page.getByRole("link", { name: "再現する", exact: true }).click();
        await browserExpect(page.getByRole("heading", { name: /ブラウザでは、読む。/ })).toBeVisible();
      } finally { await page.close(); }
    }
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
