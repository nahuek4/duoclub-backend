import mongoose from "mongoose";

const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const upper = stripAccents(raw)
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);

  if (upper === "AR") return "RA";
  if (upper === "KINEDEPO" || upper === "KINE_DEPO") return "KD";
  return upper;
}

const pricingPlanSchema = new mongoose.Schema(
  {
    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: SERVICE_KEY_RE,
      set: normalizeServiceKey,
      index: true,
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

    // Precio opcional para usuarios con cobertura/obra social.
    // null = no hay precio especial configurado.
    coveragePrice: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator(value) {
          return value === null || value === undefined || Number.isFinite(Number(value));
        },
        message: "coveragePrice inválido.",
      },
    },

    // label se usa como texto visible para las tarjetas estándar.
    label: { type: String, default: "", trim: true },

    // Tarjetas libres: pueden repetirse aunque tengan mismo servicio + pago + sesiones.
    isCustom: { type: Boolean, default: false, index: true },
    customTitle: { type: String, default: "", trim: true },

    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

pricingPlanSchema.pre("validate", function normalizeBeforeValidate() {
  this.serviceKey = normalizeServiceKey(this.serviceKey);
  this.payMethod = String(this.payMethod || "").toUpperCase().trim();
  this.credits = Number(this.credits || 0);
  this.price = Number(this.price || 0);
  this.coveragePrice =
    this.coveragePrice === null || this.coveragePrice === undefined || this.coveragePrice === ""
      ? null
      : Number(this.coveragePrice);
  this.label = String(this.label || "").trim();
  this.customTitle = String(this.customTitle || "").trim();
  this.isCustom = Boolean(this.isCustom);

  if (this.isCustom && !this.customTitle) {
    this.customTitle =
      this.label || `${this.credits} ${this.credits === 1 ? "sesión" : "sesiones"}`;
  }

  if (this.isCustom && !this.label) {
    this.label = this.customTitle;
  }
});

// No usamos índice único en serviceKey + payMethod + credits porque pueden
// existir tarjetas personalizadas con una combinación comercial equivalente.
// La unicidad de planes estándar se resuelve en /pricing/upsert.
pricingPlanSchema.index(
  { serviceKey: 1, payMethod: 1, credits: 1, isCustom: 1, active: 1 },
  { name: "pricing_lookup" }
);

pricingPlanSchema.index(
  { isCustom: 1, customTitle: 1, serviceKey: 1, payMethod: 1, credits: 1 },
  { name: "pricing_custom_title_lookup" }
);

const PricingPlan =
  mongoose.models.PricingPlan ||
  mongoose.model("PricingPlan", pricingPlanSchema);

export { normalizeServiceKey };
export default PricingPlan;
