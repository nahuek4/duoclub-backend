// backend/src/models/SubscriptionExtraSessionNotice.js
import mongoose from "mongoose";

const SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN", "NUT"];
const STATUSES = ["pending", "order_pending", "covered", "cancelled"];

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
      enum: SERVICE_KEYS,
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

    basePlanSessions: { type: Number, required: true, min: 1 },
    projectedFixedOccurrences: { type: Number, default: 0, min: 0 },
    blockedOccurrencesCount: { type: Number, default: 0, min: 0 },
    extraSessionsRequired: { type: Number, default: 0, min: 0 },
    extraSessionsPurchased: { type: Number, default: 0, min: 0 },

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
      enum: ["fixed_schedule_created", "fixed_schedule_updated", "manual_refresh"],
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
