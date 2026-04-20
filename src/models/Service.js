import mongoose from "mongoose";

const ALLOWED_SERVICE_KEYS = ["PE", "EP", "RA", "RF", "NUT"];

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  NUT: "Nutrición",
};

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
  if (ALLOWED_SERVICE_KEYS.includes(upper)) return upper;

  const normalized = stripAccents(raw).toLowerCase().trim();

  if (normalized.includes("primera") && normalized.includes("evaluacion")) {
    return "PE";
  }
  if (normalized.includes("entrenamiento") && normalized.includes("personal")) {
    return "EP";
  }
  if (normalized.includes("rehabilitacion") && normalized.includes("activa")) {
    return "RA";
  }
  if (normalized.includes("reeducacion") && normalized.includes("funcional")) {
    return "RF";
  }
  if (normalized.includes("nutric")) {
    return "NUT";
  }

  return "";
}

function inferServiceName(serviceKey, fallbackName = "") {
  const sk = normalizeServiceKey(serviceKey);
  if (sk) return SERVICE_KEY_TO_NAME[sk] || fallbackName || "";
  return String(fallbackName || "").trim();
}

const serviceSchema = new mongoose.Schema(
  {
    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ALLOWED_SERVICE_KEYS,
      unique: true,
      index: true,
    },

    // Compatibilidad con código viejo
    key: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    label: {
      type: String,
      default: "",
      trim: true,
    },

    color: {
      type: String,
      default: "#000000",
      trim: true,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

serviceSchema.pre("validate", function normalizeBeforeValidate(next) {
  const resolvedKey =
    normalizeServiceKey(this.serviceKey) ||
    normalizeServiceKey(this.key) ||
    normalizeServiceKey(this.name) ||
    normalizeServiceKey(this.label);

  if (!resolvedKey) {
    this.invalidate(
      "serviceKey",
      "serviceKey inválido. Usá PE, EP, RA, RF o NUT."
    );
    return next();
  }

  this.serviceKey = resolvedKey;
  this.key = resolvedKey;

  const visibleName =
    String(this.name || "").trim() ||
    String(this.label || "").trim() ||
    inferServiceName(resolvedKey);

  this.name = inferServiceName(resolvedKey, visibleName);

  if (!String(this.label || "").trim()) {
    this.label = this.name;
  }

  next();
});

serviceSchema.index({ serviceKey: 1 }, { unique: true });
serviceSchema.index({ active: 1, serviceKey: 1 });

const Service = mongoose.models.Service || mongoose.model("Service", serviceSchema);

export {
  Service,
  ALLOWED_SERVICE_KEYS,
  SERVICE_KEY_TO_NAME,
  normalizeServiceKey,
  inferServiceName,
};

export default Service;
