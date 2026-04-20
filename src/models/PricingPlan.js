import mongoose from "mongoose";

const ALLOWED_SERVICE_KEYS = ["PE", "EP", "RA", "RF", "NUT"];
const ALLOWED_SERVICE_KEY_SET = new Set(ALLOWED_SERVICE_KEYS);

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const upper = stripAccents(raw).toUpperCase().trim();

  if (upper === "AR") return "RA";
  if (ALLOWED_SERVICE_KEY_SET.has(upper)) return upper;

  const normalizedText = stripAccents(raw).toLowerCase().trim();

  if (normalizedText.includes("primera") && normalizedText.includes("evaluacion")) {
    return "PE";
  }
  if (normalizedText.includes("entrenamiento") && normalizedText.includes("personal")) {
    return "EP";
  }
  if (normalizedText.includes("rehabilitacion") && normalizedText.includes("activa")) {
    return "RA";
  }
  if (normalizedText.includes("reeducacion") && normalizedText.includes("funcional")) {
    return "RF";
  }
  if (normalizedText.includes("nutric")) {
    return "NUT";
  }

  return "";
}

const pricingPlanSchema = new mongoose.Schema(
  {
    // PE, EP, RA, RF, NUT
    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ALLOWED_SERVICE_KEYS,
      set: normalizeServiceKey,
    },

    // CASH, MP
    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
    },

    // cantidad de créditos
    credits: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator(value) {
          return Number.isInteger(value) && value > 0;
        },
        message: "credits debe ser un entero mayor a 0.",
      },
    },

    // precio final
    price: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator(value) {
          return Number.isFinite(Number(value));
        },
        message: "price inválido.",
      },
    },

    // label opcional
    label: { type: String, default: "", trim: true },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

pricingPlanSchema.pre("validate", function normalizeBeforeValidate(next) {
  this.serviceKey = normalizeServiceKey(this.serviceKey);
  this.payMethod = String(this.payMethod || "").toUpperCase().trim();
  this.credits = Number(this.credits || 0);
  this.price = Number(this.price || 0);
  this.label = String(this.label || "").trim();
  next();
});

pricingPlanSchema.index(
  { serviceKey: 1, payMethod: 1, credits: 1 },
  { unique: true }
);

const PricingPlan =
  mongoose.models.PricingPlan ||
  mongoose.model("PricingPlan", pricingPlanSchema);

export default PricingPlan;
