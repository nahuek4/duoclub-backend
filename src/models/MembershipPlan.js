// backend/src/models/MembershipPlan.js
import mongoose from "mongoose";

const ALLOWED_TIERS = ["BASIC", "PLUS"];
const ALLOWED_PAY_METHODS = ["CASH", "MP"];

function normalizeTier(value) {
  const raw = String(value || "").toUpperCase().trim();
  if (!raw) return "";
  if (ALLOWED_TIERS.includes(raw)) return raw;
  return "";
}

function normalizePayMethod(value) {
  const raw = String(value || "").toUpperCase().trim();
  if (!raw) return "";
  if (ALLOWED_PAY_METHODS.includes(raw)) return raw;
  return "";
}

const membershipPlanSchema = new mongoose.Schema(
  {
    tier: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ALLOWED_TIERS,
      index: true,
    },

    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ALLOWED_PAY_METHODS,
      index: true,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
      set: (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, n) : 0;
      },
    },

    label: {
      type: String,
      default: "",
      trim: true,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    durationDays: {
      type: Number,
      default: 30,
      min: 1,
      set: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return 30;
        return Math.max(1, Math.trunc(n));
      },
    },
  },
  { timestamps: true }
);

membershipPlanSchema.pre("validate", function normalizeMembershipPlan(next) {
  this.tier = normalizeTier(this.tier);
  this.payMethod = normalizePayMethod(this.payMethod);

  if (!this.label) {
    const tierLabel = this.tier === "PLUS" ? "DUO+ mensual" : "Membresía";
    const payLabel = this.payMethod === "MP" ? "Mercado Pago" : "Efectivo";
    this.label = `${tierLabel} - ${payLabel}`;
  }

  next();
});

// Un plan por tier+payMethod
membershipPlanSchema.index({ tier: 1, payMethod: 1 }, { unique: true });

const MembershipPlan =
  mongoose.models.MembershipPlan ||
  mongoose.model("MembershipPlan", membershipPlanSchema);

export default MembershipPlan;
