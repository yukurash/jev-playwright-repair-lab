import type { FixtureCase } from "../cases/index.js";

export interface Observation {
  lastAction: string | null;
  state: Record<string, string | number | boolean>;
}

interface Oracle {
  targetKey: string | null;
  expected: Record<string, string | number | boolean>;
  selection: "target" | "NO_REPAIR" | "ABSTAIN";
}

// Deliberately independent from rendered labels, locator names, and app effect handlers.
const businessGoals: Record<string, Record<string, string | number | boolean>> = {
  "checkout-order": { orders: 1, saved: false },
  "contact-email": { contact: "reader@example.test" },
  "article-publish": { visibility: "public", drafts: 0 },
  "invoice-settle": { paid: true, downloads: 0 },
  "backup-create": { backups: 1, restored: false },
  "newsletter-preferences": { newsletter: true, profileWrites: 0 },
  "pickup-location": { pickup: "Central station" },
  "team-invite": { designInvites: 1, vendorInvites: 0 },
  "access-revoke": { contractorAccess: false, ownerAccess: true },
  "delivery-window": { deliveryConfirmed: true, loadingConfirmed: false },
  "draft-or-publish": { announcementPublic: true, internalDrafts: 0 },
  "refund-or-credit": { cardRefund: 25, storeCredit: 0 },
  "two-customer-records": { inactiveArchived: true, activeArchived: false },
  "search-or-recipient": { recipient: "Ada Example" },
  "indistinguishable-approval": { selectedApproved: true, otherApproved: false },
  "deleted-coupon": { couponApplied: true },
  "retired-export": { exported: true, deleted: false },
  "removed-phone": { phone: "5550100" },
  "cancel-withdrawn": { cancelled: true, extraBookings: 0 },
  "empty-approval-queue": { expenseApproved: true },
  "payment-double-charge": { charges: 1, amount: 40 },
  "save-without-persist": { persisted: true, notifications: true },
  "invite-wrong-tenant": { currentMembers: 1, legacyMembers: 0 },
  "inventory-underflow": { available: 4, reserved: 1 },
  "email-not-sent": { sent: 1, queued: 0 },
  "assertion-only-total": { total: 45 },
  "passing-layout-control": { reportSaved: true },
  "dynamic-locator": { responses: 1 },
  "helper-locator": { active: true },
  "unsafe-locator-options": { completed: true },
};

export function oracleFor(fixture: Pick<FixtureCase, "familyId" | "category">): Oracle {
  const expected = businessGoals[fixture.familyId];
  if (!expected) throw new Error(`Missing independent oracle: ${fixture.familyId}`);
  return {
    targetKey: fixture.category === "missing" ? null : "k1",
    expected: { ...expected },
    selection: fixture.category === "missing" ? "NO_REPAIR"
      : fixture.familyId === "indistinguishable-approval" ? "ABSTAIN" : "target",
  };
}

export function evaluateOracle(fixture: FixtureCase, observed: Observation): { targetCorrect: boolean; oraclePassed: boolean } {
  const oracle = oracleFor(fixture);
  const targetCorrect = oracle.targetKey !== null && observed.lastAction === oracle.targetKey;
  return {
    targetCorrect,
    oraclePassed: targetCorrect && Object.entries(oracle.expected).every(([key, value]) => observed.state[key] === value),
  };
}
