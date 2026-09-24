import type { Category, LocatorSpec, Split } from "../../packages/core/src/index.js";

export interface CaseMetadata {
  id: string;
  familyId: string;
  split: Split;
  category: Category;
  title: string;
}

export interface Control {
  key: string;
  name: string;
  kind: "button" | "textbox";
  group?: string;
  help?: string;
  effect: Record<string, string | number | boolean>;
  status: string;
}

export interface FixturePage {
  heading: string;
  introduction: string;
  controls: Control[];
  initial: Record<string, string | number | boolean>;
}

export interface FixtureCase extends CaseMetadata {
  intent: string;
  before: FixturePage;
  after: FixturePage;
  originalTest: string;
}

interface Family {
  id: string;
  category: Category;
  title: string;
  intent: string;
  kind?: "button" | "textbox";
  oldName: string;
  newName: string;
  oldGroup?: string;
  newGroup?: string;
  distraction: string;
  distractionGroup?: string;
  goal: Record<string, string | number | boolean>;
  broken?: Record<string, string | number | boolean>;
  status: string;
  mode?: "indistinguishable" | "assertion" | "passing" | "dynamic" | "helper" | "unsafe";
}

// Each row is a distinct business scenario. Its two variants stay in one split.
const families: readonly Family[] = [
  { id: "checkout-order", category: "rename", title: "注文の確定", intent: "Place the shopping basket order, not save it for later.", oldName: "Place order", newName: "Buy these items", distraction: "Save basket", goal: { orders: 1, saved: false }, status: "Order received" },
  { id: "contact-email", category: "rename", title: "連絡用メールの入力", intent: "Enter the customer's contact email, not the receipt search query.", kind: "textbox", oldName: "Email", newName: "Contact address", distraction: "Find receipts", goal: { contact: "reader@example.test" }, status: "Contact updated" },
  { id: "article-publish", category: "rename", title: "記事を公開", intent: "Publish the finished article publicly instead of keeping a private draft.", oldName: "Publish", newName: "Make article public", distraction: "Save draft", goal: { visibility: "public", drafts: 0 }, status: "Article updated" },
  { id: "invoice-settle", category: "rename", title: "請求書の支払い", intent: "Settle the open invoice, not download its PDF.", oldName: "Pay invoice", newName: "Settle balance", distraction: "Download invoice", goal: { paid: true, downloads: 0 }, status: "Invoice paid" },
  { id: "backup-create", category: "rename", title: "バックアップの作成", intent: "Create a fresh backup, not restore the previous backup.", oldName: "Back up now", newName: "Create recovery copy", distraction: "Restore recovery copy", goal: { backups: 1, restored: false }, status: "Backup created" },
  { id: "newsletter-preferences", category: "container", title: "購読設定の移動", intent: "Save the newsletter delivery preferences, not the account profile.", oldName: "Save", newName: "Save", oldGroup: "Email preferences", newGroup: "Newsletter delivery", distraction: "Save", distractionGroup: "Account profile", goal: { newsletter: true, profileWrites: 0 }, status: "Preferences saved" },
  { id: "pickup-location", category: "container", title: "受取店舗の入力欄移動", intent: "Set the pickup store for this order rather than the billing city.", kind: "textbox", oldName: "Location", newName: "Location", oldGroup: "Collect in store", newGroup: "Pickup details", distraction: "Location", distractionGroup: "Billing address", goal: { pickup: "Central station" }, status: "Pickup updated" },
  { id: "team-invite", category: "container", title: "チーム招待の移動", intent: "Send the pending design-team invitation, not a vendor invitation.", oldName: "Send invite", newName: "Send invite", oldGroup: "Design members", newGroup: "Design workspace", distraction: "Send invite", distractionGroup: "Vendors", goal: { designInvites: 1, vendorInvites: 0 }, status: "Invitation sent" },
  { id: "access-revoke", category: "container", title: "一時アクセスの取り消し", intent: "Revoke the temporary contractor's access without revoking the owner.", oldName: "Revoke", newName: "Revoke", oldGroup: "Temporary contractor", newGroup: "Contractor access", distraction: "Revoke", distractionGroup: "Workspace owner", goal: { contractorAccess: false, ownerAccess: true }, status: "Access updated" },
  { id: "delivery-window", category: "container", title: "配送時間の確認", intent: "Confirm the delivery time window, not a warehouse loading slot.", oldName: "Confirm", newName: "Confirm", oldGroup: "Home delivery", newGroup: "Delivery appointment", distraction: "Confirm", distractionGroup: "Warehouse loading", goal: { deliveryConfirmed: true, loadingConfirmed: false }, status: "Appointment confirmed" },
  { id: "draft-or-publish", category: "ambiguous", title: "保存と公開を混同しない", intent: "Publish the announcement to subscribers, not save an internal draft.", oldName: "Publish announcement", newName: "Save and publish", newGroup: "Subscriber announcement", distraction: "Save announcement", distractionGroup: "Internal draft", goal: { announcementPublic: true, internalDrafts: 0 }, status: "Saved" },
  { id: "refund-or-credit", category: "ambiguous", title: "返金とストアクレジット", intent: "Refund the payment to the original card, not issue store credit.", oldName: "Refund payment", newName: "Return to card", newGroup: "Original payment", distraction: "Issue credit", distractionGroup: "Store balance", goal: { cardRefund: 25, storeCredit: 0 }, status: "Refund processed" },
  { id: "two-customer-records", category: "ambiguous", title: "同名の顧客操作", intent: "Archive the inactive customer record rather than the active customer.", oldName: "Archive inactive customer", newName: "Archive", newGroup: "Inactive customer", distraction: "Archive", distractionGroup: "Active customer", goal: { inactiveArchived: true, activeArchived: false }, status: "Record updated" },
  { id: "search-or-recipient", category: "ambiguous", title: "宛先と検索の似た入力欄", intent: "Enter the shipping recipient's name, not search existing recipients.", kind: "textbox", oldName: "Recipient name", newName: "Name", newGroup: "New shipping recipient", distraction: "Name", distractionGroup: "Search recipients", goal: { recipient: "Ada Example" }, status: "Name accepted" },
  { id: "indistinguishable-approval", category: "ambiguous", title: "区別できない承認先は保留", intent: "Approve the previously selected reimbursement.", oldName: "Approve selected reimbursement", newName: "Approve", distraction: "Approve", goal: { selectedApproved: true, otherApproved: false }, status: "Approved", mode: "indistinguishable" },
  { id: "deleted-coupon", category: "missing", title: "廃止されたクーポン", intent: "Apply the promotion coupon; do not replace this with purchasing gift credit.", oldName: "Apply coupon", newName: "Apply coupon", distraction: "Buy gift credit", goal: { couponApplied: true }, status: "Coupon applied" },
  { id: "retired-export", category: "missing", title: "削除されたCSV出力", intent: "Export the account ledger as CSV, not erase the ledger.", oldName: "Export CSV", newName: "Export CSV", distraction: "Delete ledger", goal: { exported: true, deleted: false }, status: "Export ready" },
  { id: "removed-phone", category: "missing", title: "電話番号欄の削除", intent: "Enter the support callback phone number, keeping internal notes unchanged.", kind: "textbox", oldName: "Callback phone", newName: "Callback phone", distraction: "Internal notes", goal: { phone: "5550100" }, status: "Phone accepted" },
  { id: "cancel-withdrawn", category: "missing", title: "キャンセル受付の終了", intent: "Cancel the pending reservation rather than book another reservation.", oldName: "Cancel reservation", newName: "Cancel reservation", distraction: "Book another reservation", goal: { cancelled: true, extraBookings: 0 }, status: "Reservation cancelled" },
  { id: "empty-approval-queue", category: "missing", title: "対象のない承認キュー", intent: "Approve the queued expense; a refresh is not an approval.", oldName: "Approve expense", newName: "Approve expense", distraction: "Refresh queue", goal: { expenseApproved: true }, status: "Expense approved" },
  { id: "payment-double-charge", category: "regression", title: "名前変更と二重請求", intent: "Charge the customer exactly once for the invoice.", oldName: "Charge invoice", newName: "Collect payment", distraction: "Preview invoice", goal: { charges: 1, amount: 40 }, broken: { charges: 2, amount: 80 }, status: "Payment complete" },
  { id: "save-without-persist", category: "regression", title: "名前変更と保存されない設定", intent: "Persist the updated notification preferences.", oldName: "Save preferences", newName: "Apply notification settings", distraction: "Reset notification settings", goal: { persisted: true, notifications: true }, broken: { persisted: false, notifications: false }, status: "Settings saved" },
  { id: "invite-wrong-tenant", category: "regression", title: "名前変更と別組織への招待", intent: "Invite the new member to this workspace, not the legacy workspace.", oldName: "Invite member", newName: "Add teammate", distraction: "Copy invitation link", goal: { currentMembers: 1, legacyMembers: 0 }, broken: { currentMembers: 0, legacyMembers: 1 }, status: "Member invited" },
  { id: "inventory-underflow", category: "regression", title: "名前変更と在庫の誤減算", intent: "Reserve one item from the five available units.", oldName: "Reserve one", newName: "Hold an item", distraction: "Release all holds", goal: { available: 4, reserved: 1 }, broken: { available: -1, reserved: 6 }, status: "Item reserved" },
  { id: "email-not-sent", category: "regression", title: "名前変更と未送信メール", intent: "Send the prepared receipt email once.", oldName: "Send receipt", newName: "Email receipt now", distraction: "Preview receipt email", goal: { sent: 1, queued: 0 }, broken: { sent: 0, queued: 1 }, status: "Receipt sent" },
  { id: "assertion-only-total", category: "guard", title: "アサーションのみの失敗", intent: "Recalculate the basket total; a business assertion failure is not a locator problem.", oldName: "Calculate total", newName: "Calculate total", distraction: "Clear basket", goal: { total: 45 }, broken: { total: 450 }, status: "Total calculated", mode: "assertion" },
  { id: "passing-layout-control", category: "guard", title: "レイアウト変更だけの対照例", intent: "Save the report; moving it on the page does not require a locator repair.", oldName: "Save report", newName: "Save report", distraction: "Open report", goal: { reportSaved: true }, status: "Report saved", mode: "passing" },
  { id: "dynamic-locator", category: "guard", title: "動的な名前は非対応", intent: "Submit the response using a dynamically assembled locator.", oldName: "Submit response", newName: "Send response", distraction: "Discard response", goal: { responses: 1 }, status: "Response sent", mode: "dynamic" },
  { id: "helper-locator", category: "guard", title: "独自ヘルパーは非対応", intent: "Activate the plan through a locator returned by a helper.", oldName: "Activate plan", newName: "Enable subscription", distraction: "Pause subscription", goal: { active: true }, status: "Plan activated", mode: "helper" },
  { id: "unsafe-locator-options", category: "guard", title: "firstとforceは非対応", intent: "Complete the task without bypassing strictness or actionability.", oldName: "Complete task", newName: "Mark task done", distraction: "Reopen task", goal: { completed: true }, status: "Task complete", mode: "unsafe" },
];

function initialFor(family: Family): Record<string, string | number | boolean> {
  const state: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(family.goal)) {
    state[key] = typeof value === "boolean" ? !value : typeof value === "number" ? 0 : "";
  }
  return state;
}

export function locatorExpression(locator: LocatorSpec): string {
  const base = locator.scope
    ? `page.getByRole("group", { name: ${JSON.stringify(locator.scope)}, exact: true })`
    : "page";
  return locator.kind === "role"
    ? `${base}.getByRole(${JSON.stringify(locator.role)}, { name: ${JSON.stringify(locator.name)}, exact: true })`
    : `${base}.getByLabel(${JSON.stringify(locator.label)}, { exact: true })`;
}

function buildCase(family: Family, position: number, variant: "a" | "b"): FixtureCase {
  const split: Split = position === 0 ? "development" : position === 1 ? "calibration" : "final";
  const kind = family.kind ?? "button";
  const isB = variant === "b";
  const suffix = isB && family.oldGroup ? " · mobile" : "";
  const oldGroup = family.oldGroup ? family.oldGroup + suffix : undefined;
  const newGroup = family.newGroup ? family.newGroup + suffix : undefined;
  const target: Control = {
    key: "k1", name: family.oldName, kind,
    ...(oldGroup ? { group: oldGroup } : {}),
    help: "Changes take effect immediately.",
    effect: family.goal, status: family.status,
  };
  const other: Control = {
    key: "k2", name: family.distraction, kind,
    ...(family.distractionGroup ? { group: family.distractionGroup + suffix } : {}),
    help: "This control performs the operation described by its own section and label.",
    effect: { unrelatedActions: 1 }, status: family.status,
  };
  const afterTarget: Control = {
    ...target, name: family.newName,
    ...(newGroup ? { group: newGroup } : {}),
    effect: family.broken ?? family.goal,
  };
  if (family.mode === "indistinguishable") {
    // Neither source order nor invisible keys are admissible evidence for this family.
    afterTarget.help = "Pending reimbursement";
    other.help = "Pending reimbursement";
  }
  if (family.mode === "passing") afterTarget.group = isB ? "Report toolbar" : "Report actions";
  const beforeControls = isB ? [other, target] : [target, other];
  let afterControls = family.category === "missing"
    ? [other]
    : isB ? [afterTarget, other] : [other, afterTarget];
  if (isB) {
    afterControls = [...afterControls, {
      key: "k3", name: kind === "button" ? "Help" : "Quick search", kind,
      group: "Utilities", help: "General navigation",
      effect: { helpOpened: true }, status: "Help opened",
    }];
  }
  const initial = initialFor(family);
  const before: FixturePage = {
    heading: family.title, introduction: "Review this self-authored example and complete the task.",
    controls: beforeControls, initial,
  };
  const after: FixturePage = {
    heading: family.title,
    introduction: family.category === "missing"
      ? "The previous workflow is no longer available. Other operations remain below."
      : isB ? "Compact view. Actions have been reorganized." : "Updated workspace.",
    controls: afterControls, initial,
  };
  const locator: LocatorSpec = kind === "textbox" && !isB
    ? { kind: "label", label: family.oldName, ...(oldGroup ? { scope: oldGroup } : {}) }
    : { kind: "role", role: kind, name: family.oldName, ...(oldGroup ? { scope: oldGroup } : {}) };
  let expression = locatorExpression(locator);
  let setup = "";
  let options = "";
  if (family.mode === "dynamic") {
    setup = `  const dynamicName = ${JSON.stringify(family.oldName)};\n`;
    expression = `page.getByRole("button", { name: dynamicName, exact: true })`;
  }
  if (family.mode === "helper") {
    setup = `  const selectControl = () => ${expression};\n`;
    expression = "selectControl()";
  }
  if (family.mode === "unsafe") {
    if (isB) options = "{ force: true }";
    else expression += ".first()";
  }
  const value = kind === "textbox" ? Object.values(family.goal).find((item) => typeof item === "string") : undefined;
  const action = kind === "textbox" ? `fill(${JSON.stringify(value)})` : `click(${options})`;
  const strong = family.mode === "assertion" || (family.category === "regression" && isB);
  const businessAssertion = strong
    ? `\n  await expect(page.getByTestId("business")).toHaveText(${JSON.stringify(JSON.stringify(family.goal))});`
    : "";
  return {
    id: `${family.id}-${variant}`, familyId: family.id, split, category: family.category,
    title: `${family.title} (${variant.toUpperCase()})`, intent: family.intent,
    before, after,
    originalTest: `test(${JSON.stringify(family.title)}, async ({ page }) => {\n  await page.goto(baseURL);\n${setup}  await ${expression}.${action};\n  await expect(page.getByTestId("status")).toHaveText(${JSON.stringify(family.status)});${businessAssertion}\n});\n`,
  };
}

const categoryCounts = new Map<Category, number>();
export const fixtureCases: readonly FixtureCase[] = families.flatMap((family) => {
  const position = categoryCounts.get(family.category) ?? 0;
  categoryCounts.set(family.category, position + 1);
  return [buildCase(family, position, "a"), buildCase(family, position, "b")];
});

export const cases: readonly CaseMetadata[] = fixtureCases.map(({ id, familyId, split, category, title }) => ({
  id, familyId, split, category, title,
}));

export const datasetManifest = {
  schemaVersion: 1 as const,
  authorship: "Original fixtures authored for this repository; no third-party applications or test suites.",
  independenceUnit: "familyId" as const,
  variantsPerFamily: 2,
  variantPolicy: "A/B vary control order, grouping, candidate count, label-vs-role input locators, and (for regressions) assertion strength. Variants are not independent samples.",
  cases,
};

export function getCase(caseId: string): FixtureCase {
  const fixture = fixtureCases.find((item) => item.id === caseId);
  if (!fixture) throw new Error(`Unknown fixture case: ${caseId}`);
  return fixture;
}
