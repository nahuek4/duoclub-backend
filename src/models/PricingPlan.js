import mongoose from "mongoose";

const pricingPlanSchema = new mongoose.Schema(
  {
    // PE, EP, RF, RA, NUT
    serviceKey: { type: String, required: true, uppercase: true, trim: true },

    // CASH, MP
    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
    },

    // cantidad de créditos
    credits: { type: Number, required: true, min: 1 },

    // precio final
    price: { type: Number, required: true, min: 0 },

    // label opcional
    label: { type: String, default: "" },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

pricingPlanSchema.index(
  { serviceKey: 1, payMethod: 1, credits: 1 },
  { unique: true }
);

const PricingPlan =
  mongoose.models.PricingPlan ||
  mongoose.model("PricingPlan", pricingPlanSchema);

export default PricingPlan;