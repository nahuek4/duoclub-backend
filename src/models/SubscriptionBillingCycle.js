// backend/src/models/SubscriptionBillingCycle.js
import mongoose from "mongoose";

const SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN", "NUT"];

const COVERAGE_STATUSES = [
  "covered",
  "extra_sessions_required",
  "pending_coverage",
  "partially_released",
];

const OCCURRENCE_STATUSES = [
  "covered",
  "pending_coverage",
  "released",
  "blocked",
  "cancelled",
];

const COVERAGE_SOURCES = ["base", "extra", "none"];
const INVOICE_STATUSES = ["pending", "paid", "overdue", "cancelled", "written_off"];
const CYCLE_PLAN_STATUSES = ["active", "suspended", "terminated", "cancelled"];

function cleanMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function cleanNonNegativeInteger(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

const addOnSnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, default: "", trim: true },
    label: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 1 },
    unitPrice: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const planSnapshotSchema = new mongoose.Schema(
  {
    pricingPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingPlan",
      default: null,
    },
    label: { type: String, default: "", trim: true },
    monthlySessions: { type: Number, required: true, min: 1 },
    basePrice: { type: Number, default: 0, min: 0 },
    regularPrice: { type: Number, default: 0, min: 0 },
    coveragePrice: { type: Number, default: null, min: 0 },
    coverageApplied: { type: Boolean, default: false },
    coverageReason: { type: String, default: "", trim: true },
    payMethod: {
      type: String,
      enum: ["CASH", "MP"],
      default: "CASH",
      uppercase: true,
      trim: true,
    },
    fixedScheduleIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "FixedSchedule",
      default: [],
    },
    addOns: { type: [addOnSnapshotSchema], default: [] },
  },
  { _id: false }
);

const occurrenceSchema = new mongoose.Schema(
  {
    fixedScheduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FixedSchedule",
      default: null,
    },
    scheduleItemIndex: { type: Number, default: 0, min: 0 },
    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    time: {
      type: String,
      required: true,
      match: /^\d{2}:\d{2}$/,
    },
    weekday: { type: Number, required: true, min: 1, max: 7 },
    status: {
      type: String,
      enum: OCCURRENCE_STATUSES,
      default: "pending_coverage",
    },
    coverageSource: {
      type: String,
      enum: COVERAGE_SOURCES,
      default: "none",
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    blockId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ScheduleBlock",
      default: null,
    },
    blockReason: { type: String, default: "", trim: true },
    releasedAt: { type: Date, default: null },
  },
  { _id: false }
);

const coverageSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: COVERAGE_STATUSES,
      default: "covered",
      index: true,
    },
    baseSessions: { type: Number, default: 0, min: 0 },
    extraSessionsSelected: { type: Number, default: 0, min: 0 },
    totalSessions: { type: Number, default: 0, min: 0 },
    fixedOccurrencesCount: { type: Number, default: 0, min: 0 },
    blockedOccurrencesCount: { type: Number, default: 0, min: 0 },
    coveredFixedOccurrences: { type: Number, default: 0, min: 0 },
    uncoveredFixedOccurrences: { type: Number, default: 0, min: 0 },
    extraSessionsNeeded: { type: Number, default: 0, min: 0 },
    additionalSessionsStillNeeded: { type: Number, default: 0, min: 0 },
    freeSessions: { type: Number, default: 0, min: 0 },
    occurrences: { type: [occurrenceSchema], default: [] },
    blockedOccurrences: { type: [occurrenceSchema], default: [] },
    calculatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const billingSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: INVOICE_STATUSES,
      default: "pending",
      index: true,
    },
    amountBase: { type: Number, default: 0, min: 0 },
    amountExtras: { type: Number, default: 0, min: 0 },
    amountAddOns: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    issuedAt: { type: Date, default: null },
    dueAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null },
    overdueAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    writtenOffAt: { type: Date, default: null },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },
    paymentProvider: { type: String, default: "", trim: true },
    paymentId: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const lifecycleSchema = new mongoose.Schema(
  {
    planStatus: {
      type: String,
      enum: CYCLE_PLAN_STATUSES,
      default: "active",
      index: true,
    },
    suspendedAt: { type: Date, default: null },
    fixedSlotsProtectedUntil: { type: Date, default: null, index: true },
    terminatedAt: { type: Date, default: null },
    terminationReason: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const creditGrantSchema = new mongoose.Schema(
  {
    granted: { type: Boolean, default: false },
    grantedSessions: { type: Number, default: 0, min: 0 },
    grantedAt: { type: Date, default: null },
    lotId: { type: mongoose.Schema.Types.ObjectId, default: null },
    expiresAt: { type: Date, default: null },
    invalidatedAt: { type: Date, default: null },
    invalidationReason: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const notificationSchema = new mongoose.Schema(
  {
    renewalPreviewSentAt: { type: Date, default: null },
    renewalConfirmationSentAt: { type: Date, default: null },
    paymentReminderSentAt: { type: Date, default: null },
    suspensionSentAt: { type: Date, default: null },
    finalWarningSentAt: { type: Date, default: null },
    terminationSentAt: { type: Date, default: null },
    reactivationSentAt: { type: Date, default: null },
  },
  { _id: false }
);

const subscriptionBillingCycleSchema = new mongoose.Schema(
  {
    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceSubscription",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    serviceKey: {
      type: String,
      required: true,
      enum: SERVICE_KEYS,
      uppercase: true,
      trim: true,
      index: true,
    },
    periodKey: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}$/,
      index: true,
    },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    idempotencyKey: { type: String, required: true, trim: true, unique: true },

    planSnapshot: { type: planSnapshotSchema, required: true },
    coverage: { type: coverageSchema, default: () => ({}) },
    billing: { type: billingSchema, default: () => ({}) },
    lifecycle: { type: lifecycleSchema, default: () => ({}) },
    creditGrant: { type: creditGrantSchema, default: () => ({}) },
    notifications: { type: notificationSchema, default: () => ({}) },

    appointmentsGeneratedAt: { type: Date, default: null },
    generatedAppointmentIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Appointment",
      default: [],
    },
  },
  { timestamps: true }
);

subscriptionBillingCycleSchema.pre("validate", function normalizeCycle() {
  this.serviceKey = String(this.serviceKey || "").toUpperCase().trim();
  this.periodKey = String(this.periodKey || "").trim();

  if (this.subscription && this.periodKey) {
    this.idempotencyKey = `${String(this.subscription)}:${this.periodKey}`;
  }

  const snapshot = this.planSnapshot || {};
  snapshot.monthlySessions = Math.max(1, cleanNonNegativeInteger(snapshot.monthlySessions));
  snapshot.basePrice = cleanMoney(snapshot.basePrice);
  snapshot.regularPrice = cleanMoney(snapshot.regularPrice || snapshot.basePrice);
  if (snapshot.coveragePrice !== null && snapshot.coveragePrice !== undefined) {
    snapshot.coveragePrice = cleanMoney(snapshot.coveragePrice);
  }
  snapshot.payMethod = String(snapshot.payMethod || "CASH").toUpperCase().trim();
  this.planSnapshot = snapshot;

  const coverage = this.coverage || {};
  coverage.baseSessions = cleanNonNegativeInteger(coverage.baseSessions);
  coverage.extraSessionsSelected = cleanNonNegativeInteger(coverage.extraSessionsSelected);
  coverage.totalSessions = coverage.baseSessions + coverage.extraSessionsSelected;
  coverage.fixedOccurrencesCount = cleanNonNegativeInteger(coverage.fixedOccurrencesCount);
  coverage.blockedOccurrencesCount = cleanNonNegativeInteger(coverage.blockedOccurrencesCount);
  coverage.coveredFixedOccurrences = cleanNonNegativeInteger(coverage.coveredFixedOccurrences);
  coverage.uncoveredFixedOccurrences = cleanNonNegativeInteger(coverage.uncoveredFixedOccurrences);
  coverage.extraSessionsNeeded = cleanNonNegativeInteger(coverage.extraSessionsNeeded);
  coverage.additionalSessionsStillNeeded = cleanNonNegativeInteger(
    coverage.additionalSessionsStillNeeded
  );
  coverage.freeSessions = cleanNonNegativeInteger(coverage.freeSessions);
  this.coverage = coverage;

  const billing = this.billing || {};
  billing.amountBase = cleanMoney(billing.amountBase);
  billing.amountExtras = cleanMoney(billing.amountExtras);
  billing.amountAddOns = cleanMoney(billing.amountAddOns);
  billing.total = cleanMoney(
    billing.total || billing.amountBase + billing.amountExtras + billing.amountAddOns
  );
  this.billing = billing;
});

subscriptionBillingCycleSchema.index(
  { subscription: 1, periodKey: 1 },
  { unique: true, name: "subscription_period_unique" }
);
subscriptionBillingCycleSchema.index({ user: 1, periodKey: 1, serviceKey: 1 });
subscriptionBillingCycleSchema.index({ "billing.status": 1, "billing.dueAt": 1 });
subscriptionBillingCycleSchema.index({ "lifecycle.planStatus": 1, periodKey: 1 });
subscriptionBillingCycleSchema.index({ "coverage.status": 1, periodKey: 1 });

const SubscriptionBillingCycle =
  mongoose.models.SubscriptionBillingCycle ||
  mongoose.model("SubscriptionBillingCycle", subscriptionBillingCycleSchema);

export default SubscriptionBillingCycle;
export {
  COVERAGE_STATUSES,
  OCCURRENCE_STATUSES,
  INVOICE_STATUSES,
  CYCLE_PLAN_STATUSES,
};
