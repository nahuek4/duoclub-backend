// backend/src/models/PricingPlan.js
import mongoose from "mongoose";

const pricingPlanSchema = new mongoose.Schema(
  {
    // EP, RF, AR, RA, NUT
    serviceKey: { type: String, required: true, uppercase: true, trim: true },

    // CASH, MP
    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
    },

    // cantidad de créditos (o 1 para NUT “sesión”)
    credits: { type: Number, required: true, min: 1 },

    // precio final
    price: { type: Number, required: true, min: 0 },

    // label opcional (ej: "Sesión")
    label: { type: String, default: "" },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Evita duplicados para un mismo plan
pricingPlanSchema.index(
  { serviceKey: 1, payMethod: 1, credits: 1 },
  { unique: true }
);

const PricingPlan = mongoose.model("PricingPlan", pricingPlanSchema);
export default PricingPlan;
