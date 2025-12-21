// backend/src/models/MembershipPlan.js
import mongoose from "mongoose";

const membershipPlanSchema = new mongoose.Schema(
  {
    tier: { type: String, required: true, uppercase: true, trim: true }, // "PLUS"
    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
    },
    price: { type: Number, required: true, min: 0 },
    label: { type: String, default: "" }, // ej: "DUO+ mensual"
    active: { type: Boolean, default: true },
    durationDays: { type: Number, default: 30, min: 1 }, // por defecto 30 días
  },
  { timestamps: true }
);

// Un plan por tier+payMethod
membershipPlanSchema.index({ tier: 1, payMethod: 1 }, { unique: true });

const MembershipPlan = mongoose.model("MembershipPlan", membershipPlanSchema);
export default MembershipPlan;
