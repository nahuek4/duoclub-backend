import mongoose from "mongoose";

const ALLOWED_SERVICE_KEYS = ["PE", "EP", "RA", "RF", "KD", "NUT"];
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
  if (upper === "KINEDEPO" || upper === "KINE-DEPO") return "KD";
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
  if (
    normalizedText.includes("kinefilax") ||
    normalizedText.includes("kine depo") ||
    normalizedText.includes("kinefilaxia deportiva")
  ) {
    return "KD";
  }
  if (normalizedText.includes("nutric")) {
    return "NUT";
  }

  return "";
}

const pricingPlanSchema = new mongoose.Schema(
  {
    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ALLOWED_SERVICE_KEYS,
      set: normalizeServiceKey,
    },

    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
    },

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

    // label se usa como texto visible para las tarjetas estándar.
    label: { type: String, default: "", trim: true },

    // Tarjetas libres: pueden repetirse aunque tengan mismo servicio + pago + sesiones.
    isCustom: { type: Boolean, default: false, index: true },
    customTitle: { type: String, default: "", trim: true },

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
  this.customTitle = String(this.customTitle || "").trim();
  this.isCustom = Boolean(this.isCustom);

  if (this.isCustom && !this.customTitle) {
    this.customTitle = this.label || `${this.credits} ${this.credits === 1 ? "sesión" : "sesiones"}`;
  }

  if (this.isCustom && !this.label) {
    this.label = this.customTitle;
  }

  next();
});

// IMPORTANTE:
// Este índice mantiene única solo la combinación de planes estándar.
// Las tarjetas libres (isCustom: true) pueden repetir serviceKey + payMethod + credits.
pricingPlanSchema.index(
  { serviceKey: 1, payMethod: 1, credits: 1 },
  {
    unique: true,
    partialFilterExpression: { isCustom: { $ne: true } },
    name: "uniq_standard_pricing_plan",
  }
);

pricingPlanSchema.index(
  { isCustom: 1, serviceKey: 1, payMethod: 1, active: 1, credits: 1 },
  { name: "pricing_custom_lookup" }
);

const PricingPlan =
  mongoose.models.PricingPlan ||
  mongoose.model("PricingPlan", pricingPlanSchema);

export default PricingPlan;
