import type { PublicDataset, TrialResult } from "../../../packages/core/src/index";

// Test-only records are injected into isolated test builds, never the public dataset.
export function trialFixture(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    schemaVersion: 1,
    caseId: "test-rename",
    familyId: "test-settings",
    split: "development",
    category: "rename",
    title: "ブラウザテスト専用ケース",
    provider: "rule",
    model: "test-only",
    status: "repaired",
    decision: "c0",
    expectedDecision: "c0",
    baselinePassed: true,
    originalTestPassed: true,
    oraclePassed: false,
    targetCorrect: false,
    repairable: true,
    beforeHtml: "<main><h1>通知の設定</h1><button>保存</button></main>",
    afterHtml: "<main><h1>通知の設定</h1><button>変更を保存</button></main>",
    originalTest: "await page.getByRole('button', { name: '保存' }).click();\nawait expect(page.getByRole('status')).toHaveText('保存しました');",
    repairedTest: "await page.getByRole('button', { name: '変更を保存' }).click();\nawait expect(page.getByRole('status')).toHaveText('保存しました');",
    candidates: [{ id: "c0", locator: { kind: "role", role: "button", name: "変更を保存" }, context: "通知の設定" }],
    latency: { captureMs: 10, decisionMs: 3, validationMs: 15, totalMs: 28 },
    sourceSha: "a".repeat(40),
    recordedAt: "2026-01-01T00:00:00.000Z",
    inference: "deterministic",
    ...overrides,
  };
}

export function datasetFixture(trials: TrialResult[] = []): PublicDataset {
  return {
    schemaVersion: 1,
    label: "テスト専用・実測ではありません",
    generatedAt: trials.length ? "2026-01-01T00:00:00.000Z" : null,
    sourceSha: trials.length ? "a".repeat(40) : null,
    publicationApproved: trials.length > 0,
    trials,
  };
}
