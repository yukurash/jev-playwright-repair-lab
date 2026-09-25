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

export function comparisonFixture(): PublicDataset {
  const providers = ["azure", "jev", "rule"] as const;
  const trials = providers.flatMap((provider) => Array.from({ length: 3 }, (_, repetition) => trialFixture({
    provider, split: "final",
    model: provider === "azure" ? "gpt-5.5" : provider,
    sourceSha: (provider === "azure" ? "a" : "b").repeat(40),
    recordedAt: `2026-01-0${providers.indexOf(provider) + 1}T00:01:0${repetition}.000Z`,
    inference: provider === "rule" ? "deterministic" : "live",
    ...(provider === "rule" ? {} : { usage: { inputTokens: 100, outputTokens: 2 } }),
    ...(provider === "jev" ? { route: "openrouter" } : {}),
  })));
  return {
    ...datasetFixture(trials), sourceSha: null,
    generatedAt: "2026-01-04T00:00:00.000Z",
    comparison: {
      kind: "separate-final-runs", split: "final", caseIds: ["test-rename"], seed: 42, repetitions: 3,
      lockfileSha256: "c".repeat(64), instructionSha256: "d".repeat(64),
      runs: providers.map((provider, index) => ({
        provider, sourceSha: (provider === "azure" ? "a" : "b").repeat(40),
        frozenAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        firstRecordedAt: `2026-01-0${index + 1}T00:01:00.000Z`,
        lastRecordedAt: `2026-01-0${index + 1}T00:01:02.000Z`,
        seed: 42, repetitions: 3, trialCount: 3,
      })),
    },
  };
}
