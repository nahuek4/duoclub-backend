// backend/src/models/SubscriptionExtraSessionNotice.js
import mongoose from "mongoose";

const SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN", "NUT"];
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;
const STATUSES = ["pending", "order_pending", "covered", "cancelled"];

const SOURCES = [
  "fixed_schedule_created",
  "fixed_schedule_updated",
  "fixed_schedule_deleted",
  "fixed_appointment_cancelled",
  "fixed_appointment_rescheduled",
  "manual_refresh",
  "plan_purchase_paid",
  "admin_monthly_plan_created",
  "admin_monthly_plan_updated",
];

function cleanNonNegativeInteger(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

const subscriptionExtraSessionNoticeSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceSubscription",
      required: true,
      index: true,
    },
    serviceKey: {
      type: String,
      match: SERVICE_KEY_RE,
      required: true,
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

    fixedScheduleIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "FixedSchedule",
      default: [],
    },

    // Estado actual del período. Puede bajar si se elimina/cancela un turno fijo.
    basePlanSessions: { type: Number, required: true, min: 1 },
    projectedFixedOccurrences: { type: Number, default: 0, min: 0 },
    blockedOccurrencesCount: { type: Number, default: 0, min: 0 },
    extraSessionsRequired: { type: Number, default: 0, min: 0 },
    extraSessionsPurchased: { type: Number, default: 0, min: 0 },

    // Huella histórica del período. Nunca se reduce durante recálculos normales.
    // Permite mostrar "debía 1 / pagó 1" aunque hoy el pendiente sea 0.
    historicalBasePlanSessions: { type: Number, default: 0, min: 0 },
    historicalFixedOccurrences: { type: Number, default: 0, min: 0 },
    historicalExtraSessionsRequired: { type: Number, default: 0, min: 0 },
    historicalFirstDetectedAt: { type: Date, default: null },
    historicalLastChangedAt: { type: Date, default: null },
    occurrenceSource: { type: String, default: "", trim: true },

    status: {
      type: String,
      enum: STATUSES,
      default: "pending",
      index: true,
    },

    pendingOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },
    lastPaidOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    purchasedOrderIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Order",
      default: [],
    },

    calculatedAt: { type: Date, default: Date.now },
    calculatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    source: {
      type: String,
      enum: SOURCES,
      default: "manual_refresh",
    },
  },
  { timestamps: true }
);

subscriptionExtraSessionNoticeSchema.pre("validate", function normalizeNotice() {
  this.serviceKey = String(this.serviceKey || "").toUpperCase().trim();
  this.periodKey = String(this.periodKey || "").trim();
  this.basePlanSessions = Math.max(1, cleanNonNegativeInteger(this.basePlanSessions));
  this.projectedFixedOccurrences = cleanNonNegativeInteger(
    this.projectedFixedOccurrences
  );
  this.blockedOccurrencesCount = cleanNonNegativeInteger(
    this.blockedOccurrencesCount
  );
  this.extraSessionsRequired = cleanNonNegativeInteger(
    this.extraSessionsRequired
  );
  this.extraSessionsPurchased = cleanNonNegativeInteger(
    this.extraSessionsPurchased
  );
  this.historicalBasePlanSessions = cleanNonNegativeInteger(
    this.historicalBasePlanSessions
  );
  this.historicalFixedOccurrences = cleanNonNegativeInteger(
    this.historicalFixedOccurrences
  );
  this.historicalExtraSessionsRequired = Math.max(
    cleanNonNegativeInteger(this.historicalExtraSessionsRequired),
    this.extraSessionsRequired
  );

  // Compatibilidad con avisos creados antes de agregar la huella histórica.
  if (this.historicalExtraSessionsRequired > 0) {
    if (!this.historicalBasePlanSessions) {
      this.historicalBasePlanSessions = this.basePlanSessions;
    }
    if (!this.historicalFixedOccurrences) {
      this.historicalFixedOccurrences = this.projectedFixedOccurrences;
    }
    if (!this.historicalFirstDetectedAt) {
      this.historicalFirstDetectedAt = this.createdAt || new Date();
    }
  }
  this.fixedScheduleIds = Array.from(
    new Set(
      (Array.isArray(this.fixedScheduleIds) ? this.fixedScheduleIds : [])
        .map(String)
        .filter(Boolean)
    )
  );
  this.purchasedOrderIds = Array.from(
    new Set(
      (Array.isArray(this.purchasedOrderIds) ? this.purchasedOrderIds : [])
        .map(String)
        .filter(Boolean)
    )
  );

  const remaining = Math.max(
    0,
    this.extraSessionsRequired - this.extraSessionsPurchased
  );

  if (remaining === 0) {
    this.status = this.extraSessionsRequired > 0 ? "covered" : "cancelled";
    this.pendingOrder = null;
  } else if (this.pendingOrder) {
    this.status = "order_pending";
  } else {
    this.status = "pending";
  }
});

subscriptionExtraSessionNoticeSchema.virtual("remainingSessions").get(function () {
  return Math.max(
    0,
    cleanNonNegativeInteger(this.extraSessionsRequired) -
      cleanNonNegativeInteger(this.extraSessionsPurchased)
  );
});

subscriptionExtraSessionNoticeSchema.virtual("historicalRemainingSessions").get(function () {
  return Math.max(
    0,
    cleanNonNegativeInteger(this.historicalExtraSessionsRequired) -
      cleanNonNegativeInteger(this.extraSessionsPurchased)
  );
});

subscriptionExtraSessionNoticeSchema.set("toJSON", { virtuals: true });
subscriptionExtraSessionNoticeSchema.set("toObject", { virtuals: true });

subscriptionExtraSessionNoticeSchema.index(
  { user: 1, serviceKey: 1, periodKey: 1 },
  { unique: true, name: "subscription_extra_notice_unique_period" }
);
subscriptionExtraSessionNoticeSchema.index({ status: 1, periodKey: 1, user: 1 });

const SubscriptionExtraSessionNotice =
  mongoose.models.SubscriptionExtraSessionNotice ||
  mongoose.model(
    "SubscriptionExtraSessionNotice",
    subscriptionExtraSessionNoticeSchema
  );

export default SubscriptionExtraSessionNotice;
