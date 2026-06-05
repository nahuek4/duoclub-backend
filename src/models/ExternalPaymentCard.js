import mongoose from "mongoose";

const ALLOWED_SERVICE_KEYS = ["PE", "EP", "RA", "RF", "KD", "NUT"];
const ALLOWED_SERVICE_KEY_SET = new Set(ALLOWED_SERVICE_KEYS);

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKey(value, { allowEmpty = true } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return allowEmpty ? "" : null;

  const upper = stripAccents(raw).toUpperCase().trim();

  if (upper === "AR") return "RA";
  if (upper === "KINEDEPO" || upper === "KINE-DEPO") return "KD";
  if (ALLOWED_SERVICE_KEY_SET.has(upper)) return upper;

  const s = stripAccents(raw).toLowerCase().trim();
  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilax") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("nutric")) return "NUT";

  return allowEmpty ? "" : null;
}

function slugify(value) {
  const base = stripAccents(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return base || "";
}

function cleanString(value) {
  return String(value || "").trim();
}

const externalPaymentCardSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator(value) {
          return Number.isFinite(Number(value)) && Number(value) > 0;
        },
        message: "El monto debe ser mayor a 0.",
      },
    },

    active: { type: Boolean, default: true, index: true },

    // Reutilizable por defecto.
    reusable: { type: Boolean, default: true },

    // Límites opcionales.
    maxApprovedPayments: { type: Number, default: null, min: 1 },
    expiresAt: { type: Date, default: null },

    // Impacto en app.
    addsCredits: { type: Boolean, default: false },
    serviceKey: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
      validate: {
        validator(value) {
          const normalized = normalizeServiceKey(value, { allowEmpty: true });
          if (!this.addsCredits) return normalized === "";
          return ALLOWED_SERVICE_KEY_SET.has(normalized);
        },
        message: "Servicio inválido para la tarjeta externa.",
      },
    },
    sessionsQty: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator(value) {
          const n = Number(value || 0);
          if (!this.addsCredits) return n === 0;
          return Number.isInteger(n) && n > 0;
        },
        message: "La cantidad de sesiones debe ser un entero mayor a 0.",
      },
    },

    assignmentMode: {
      type: String,
      enum: ["auto_by_email", "manual"],
      default: "auto_by_email",
      trim: true,
    },

    approvedPaymentsCount: { type: Number, default: 0, min: 0 },
    totalApprovedAmount: { type: Number, default: 0, min: 0 },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

externalPaymentCardSchema.pre("validate", function normalizeExternalPaymentCard() {
  this.title = cleanString(this.title);
  this.description = cleanString(this.description);

  const inputSlug = cleanString(this.slug);
  this.slug = slugify(inputSlug || this.title);

  this.amount = Math.round(Number(this.amount || 0));
  this.active = Boolean(this.active);
  this.reusable = this.reusable !== false;

  if (this.maxApprovedPayments === "" || this.maxApprovedPayments === undefined) {
    this.maxApprovedPayments = null;
  } else if (this.maxApprovedPayments !== null) {
    const maxUses = Number(this.maxApprovedPayments);
    this.maxApprovedPayments =
      Number.isFinite(maxUses) && maxUses > 0 ? Math.trunc(maxUses) : null;
  }

  this.addsCredits = Boolean(this.addsCredits);

  if (this.addsCredits) {
    this.serviceKey = normalizeServiceKey(this.serviceKey, { allowEmpty: false }) || "";
    this.sessionsQty = Math.max(1, Math.trunc(Number(this.sessionsQty || 0)));
    this.assignmentMode =
      String(this.assignmentMode || "").trim() === "manual" ? "manual" : "auto_by_email";
  } else {
    this.serviceKey = "";
    this.sessionsQty = 0;
    this.assignmentMode = "manual";
  }

  this.approvedPaymentsCount = Math.max(0, Math.trunc(Number(this.approvedPaymentsCount || 0)));
  this.totalApprovedAmount = Math.max(0, Math.round(Number(this.totalApprovedAmount || 0)));
});

externalPaymentCardSchema.methods.isPubliclyPayable = function isPubliclyPayable() {
  if (!this.active) return false;

  const expiresAt = this.expiresAt ? new Date(this.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) return false;

  const max = this.maxApprovedPayments;
  if (max !== null && max !== undefined && Number(max) > 0) {
    return Number(this.approvedPaymentsCount || 0) < Number(max);
  }

  return true;
};

externalPaymentCardSchema.index({ active: 1, createdAt: -1 });
externalPaymentCardSchema.index({ createdAt: -1 });
externalPaymentCardSchema.index({ expiresAt: 1, active: 1 });

const ExternalPaymentCard =
  mongoose.models.ExternalPaymentCard ||
  mongoose.model("ExternalPaymentCard", externalPaymentCardSchema);

export default ExternalPaymentCard;
