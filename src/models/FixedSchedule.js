// backend/src/models/FixedSchedule.js
import mongoose from "mongoose";

const ALLOWED_SERVICE_KEYS = ["PE", "EP", "RA", "RF", "NUT"];
const ALLOWED_SERVICE_KEY_SET = new Set(ALLOWED_SERVICE_KEYS);

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
  if (ALLOWED_SERVICE_KEY_SET.has(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();
  if (text.includes("primera") && text.includes("evaluacion")) return "PE";
  if (text.includes("entrenamiento") && text.includes("personal")) return "EP";
  if (text.includes("rehabilitacion") && text.includes("activa")) return "RA";
  if (text.includes("reeducacion") && text.includes("funcional")) return "RF";
  if (text.includes("nutric")) return "NUT";

  return "";
}

function getServiceNameFromKey(serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  return SERVICE_KEY_TO_NAME[key] || "";
}

const fixedScheduleItemSchema = new mongoose.Schema(
  {
    // 1 = lunes, 2 = martes ... 5 = viernes
    weekday: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },

    // HH:mm
    time: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{2}:\d{2}$/,
    },
  },
  { _id: false }
);

const fixedScheduleSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ALLOWED_SERVICE_KEYS,
      index: true,
    },

    // Compatibilidad / display
    service: {
      type: String,
      default: "",
      trim: true,
    },

    items: {
      type: [fixedScheduleItemSchema],
      default: [],
      validate: {
        validator(arr) {
          if (!Array.isArray(arr) || !arr.length) return false;

          const seen = new Set();
          for (const it of arr) {
            const key = `${it?.weekday}__${it?.time}`;
            if (seen.has(key)) return false;
            seen.add(key);
          }
          return true;
        },
        message:
          "La configuración fija debe tener al menos un ítem y no puede repetir día/horario.",
      },
    },

    months: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      default: 1,
    },

    // rango que cubre la configuración
    startDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    endDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    notes: {
      type: String,
      default: "",
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

fixedScheduleSchema.pre("validate", function normalizeFixedScheduleService(next) {
  const normalizedKey = normalizeServiceKey(this.serviceKey || this.service);

  if (!normalizedKey) {
    this.invalidate(
      "serviceKey",
      "serviceKey inválido. Valores permitidos: PE, EP, RA, RF, NUT."
    );
    return next();
  }

  this.serviceKey = normalizedKey;

  if (!String(this.service || "").trim()) {
    this.service = getServiceNameFromKey(normalizedKey);
  }

  return next();
});

// para listar configuraciones activas de un usuario
fixedScheduleSchema.index({ user: 1, active: 1, serviceKey: 1, createdAt: -1 });

// para filtrar por vigencia
fixedScheduleSchema.index({ active: 1, serviceKey: 1, startDate: 1, endDate: 1 });

const FixedSchedule =
  mongoose.models.FixedSchedule ||
  mongoose.model("FixedSchedule", fixedScheduleSchema);

export default FixedSchedule;
