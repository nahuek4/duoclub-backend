import mongoose from "mongoose";

const TYPES = [
  "renewal_preview",
  "payment_pending",
  "suspended",
  "final_warning",
  "terminated",
  "reactivated",
  "plan_change_applied",
];

const subscriptionLifecycleNoticeSchema = new mongoose.Schema(
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
    cycle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionBillingCycle",
      default: null,
      index: true,
    },
    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["EP", "RA", "RF", "KD", "SYN", "NUT"],
      index: true,
    },
    periodKey: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}$/,
      index: true,
    },
    type: {
      type: String,
      enum: TYPES,
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    action: {
      type: String,
      enum: ["none", "pay", "change_plan"],
      default: "none",
    },
    actionRequired: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["unread", "read", "resolved"],
      default: "unread",
      index: true,
    },
    readAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

subscriptionLifecycleNoticeSchema.index(
  { user: 1, subscription: 1, periodKey: 1, type: 1 },
  { unique: true, name: "subscription_lifecycle_notice_unique" }
);
subscriptionLifecycleNoticeSchema.index({ user: 1, status: 1, createdAt: -1 });

const SubscriptionLifecycleNotice =
  mongoose.models.SubscriptionLifecycleNotice ||
  mongoose.model("SubscriptionLifecycleNotice", subscriptionLifecycleNoticeSchema);

export default SubscriptionLifecycleNotice;
export { TYPES as SUBSCRIPTION_LIFECYCLE_NOTICE_TYPES };
