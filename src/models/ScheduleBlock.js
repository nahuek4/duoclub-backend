import mongoose from "mongoose";

const SERVICE_KEYS = ["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"];
const SERVICE_KEY_SET = new Set(SERVICE_KEYS);

function cleanString(value) {
  return String(value || "").trim();
}

function cleanYmd(value) {
  const s = cleanString(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function cleanTime(value) {
  const s = cleanString(value).slice(0, 5);
  return /^\d{2}:\d{2}$/.test(s) ? s : "";
}

function normalizeServiceKey(value) {
  const up = cleanString(value).toUpperCase();
  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (up === "SINERGIA") return "SYN";
  return SERVICE_KEY_SET.has(up) ? up : "";
}

function normalizeWeekday(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return n >= 1 && n <= 7 ? n : null;
}

const scheduleBlockSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      default: "Bloqueo de agenda",
    },

    reason: {
      type: String,
      default: "",
      trim: true,
    },

    serviceKeys: {
      type: [String],
      required: true,
      default: [],
      validate: {
        validator(value) {
          return (
            Array.isArray(value) &&
            value.length > 0 &&
            value.every((x) => SERVICE_KEY_SET.has(String(x || "").toUpperCase()))
          );
        },
        message: "Debe seleccionar al menos un servicio válido.",
      },
    },

    allServices: { type: Boolean, default: false },

    dateFrom: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    dateTo: {
      type: String,
      default: "",
      trim: true,
    },

    indefinite: { type: Boolean, default: false },

    allDay: { type: Boolean, default: true },

    timeFrom: {
      type: String,
      default: "",
      trim: true,
    },

    timeTo: {
      type: String,
      default: "",
      trim: true,
    },

    // 1 = lunes, 2 = martes ... 7 = domingo.
    // Si queda vacío, aplica a todas las fechas del rango.
    weekdays: {
      type: [Number],
      default: [],
    },

    active: { type: Boolean, default: true, index: true },

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

scheduleBlockSchema.pre("validate", function normalizeScheduleBlock() {
  this.title = cleanString(this.title) || "Bloqueo de agenda";
  this.reason = cleanString(this.reason);

  const keys = Array.isArray(this.serviceKeys) ? this.serviceKeys : [];
  const normalizedKeys = keys
    .map(normalizeServiceKey)
    .filter(Boolean);

  this.serviceKeys = Array.from(new Set(normalizedKeys));
  this.allServices = this.serviceKeys.length === SERVICE_KEYS.length;

  this.dateFrom = cleanYmd(this.dateFrom);

  if (this.indefinite) {
    this.dateTo = "";
  } else {
    this.dateTo = cleanYmd(this.dateTo) || this.dateFrom;
  }

  this.allDay = Boolean(this.allDay);

  if (this.allDay) {
    this.timeFrom = "";
    this.timeTo = "";
  } else {
    this.timeFrom = cleanTime(this.timeFrom);
    this.timeTo = cleanTime(this.timeTo);
  }

  const weekdays = Array.isArray(this.weekdays) ? this.weekdays : [];
  this.weekdays = Array.from(
    new Set(weekdays.map(normalizeWeekday).filter((x) => x !== null))
  ).sort((a, b) => a - b);

  if (!this.dateFrom) {
    throw new Error("La fecha desde es obligatoria.");
  }

  if (!this.indefinite && this.dateTo && this.dateTo < this.dateFrom) {
    throw new Error("La fecha hasta no puede ser anterior a fecha desde.");
  }

  if (!this.allDay) {
    if (!this.timeFrom || !this.timeTo) {
      throw new Error("Para bloqueo por franja horaria indicá horario desde y hasta.");
    }
    if (this.timeTo <= this.timeFrom) {
      throw new Error("El horario hasta debe ser posterior al horario desde.");
    }
  }
});

scheduleBlockSchema.index({ active: 1, dateFrom: 1, dateTo: 1 });
scheduleBlockSchema.index({ active: 1, serviceKeys: 1, dateFrom: 1 });
scheduleBlockSchema.index({ createdAt: -1 });

const ScheduleBlock =
  mongoose.models.ScheduleBlock || mongoose.model("ScheduleBlock", scheduleBlockSchema);

export default ScheduleBlock;
export { SERVICE_KEYS };
