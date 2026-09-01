// backend/src/models/ServiceDefinition.js
import mongoose from "mongoose";

const TIME_RE = /^\d{2}:\d{2}$/;
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;
const CAPACITY_GROUPS = ["NONE", "TRAINING", "PERFORMANCE"];

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function normalizeTime(value) {
  return clean(value).slice(0, 5);
}

function minutesOf(value) {
  const [h, m] = normalizeTime(value).split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return NaN;
  return h * 60 + m;
}

const hourRangeSchema = new mongoose.Schema(
  {
    from: {
      type: String,
      required: true,
      trim: true,
      match: TIME_RE,
    },
    to: {
      type: String,
      required: true,
      trim: true,
      match: TIME_RE,
    },
  },
  { _id: false }
);

const weeklyHoursSchema = new mongoose.Schema(
  {
    weekday: {
      type: Number,
      required: true,
      min: 1,
      max: 7,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    ranges: {
      type: [hourRangeSchema],
      default: [],
    },
  },
  { _id: false }
);

const serviceDefinitionSchema = new mongoose.Schema(
  {
    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      unique: true,
      index: true,
      immutable: true,
      match: SERVICE_KEY_RE,
      set: normalizeKey,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    category: {
      type: String,
      default: "other",
      trim: true,
      lowercase: true,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    // Si false, existe para historial/compatibilidad pero no aparece
    // en el catálogo normal de la aplicación.
    catalogVisible: {
      type: Boolean,
      default: true,
      index: true,
    },

    purchasable: {
      type: Boolean,
      default: true,
    },

    reservable: {
      type: Boolean,
      default: true,
    },

    recurringPlanEnabled: {
      type: Boolean,
      default: true,
    },

    fixedScheduleEnabled: {
      type: Boolean,
      default: true,
    },

    waitlistEnabled: {
      type: Boolean,
      default: false,
    },

    capacityGroup: {
      type: String,
      uppercase: true,
      trim: true,
      enum: CAPACITY_GROUPS,
      default: "NONE",
      index: true,
    },

    duration: {
      type: Number,
      default: 60,
      min: 5,
      max: 360,
    },

    slotMinutes: {
      type: Number,
      default: 60,
      min: 5,
      max: 240,
    },

    minBookingMinutes: {
      type: Number,
      default: 60,
      min: 0,
      max: 60 * 24 * 30,
    },

    maxAdvanceDays: {
      type: Number,
      default: 30,
      min: 0,
      max: 365,
    },

    cancellationCutoffHours: {
      type: Number,
      default: 1,
      min: 0,
      max: 24 * 30,
    },

    sortOrder: {
      type: Number,
      default: 100,
    },

    weeklyHours: {
      type: [weeklyHoursSchema],
      default: [],
    },

    // Marca servicios que existen por compatibilidad histórica pero que
    // actualmente no forman parte de la operatoria principal.
    legacy: {
      type: Boolean,
      default: false,
      index: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

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

serviceDefinitionSchema.pre("validate", function normalizeServiceDefinition() {
  this.serviceKey = normalizeKey(this.serviceKey);
  this.name = clean(this.name);
  this.description = clean(this.description);
  this.category = clean(this.category || "other").toLowerCase() || "other";
  this.capacityGroup = clean(this.capacityGroup || "NONE").toUpperCase() || "NONE";

  this.duration = Math.max(5, Math.trunc(Number(this.duration || 60)));
  this.slotMinutes = Math.max(5, Math.trunc(Number(this.slotMinutes || 60)));
  this.minBookingMinutes = Math.max(0, Math.trunc(Number(this.minBookingMinutes || 0)));
  this.maxAdvanceDays = Math.max(0, Math.trunc(Number(this.maxAdvanceDays || 0)));
  this.cancellationCutoffHours = Math.max(
    0,
    Number(this.cancellationCutoffHours || 0)
  );
  this.sortOrder = Number.isFinite(Number(this.sortOrder))
    ? Number(this.sortOrder)
    : 100;

  const byWeekday = new Map();

  for (const rawDay of Array.isArray(this.weeklyHours) ? this.weeklyHours : []) {
    const weekday = Number(rawDay?.weekday || 0);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;

    const ranges = (Array.isArray(rawDay?.ranges) ? rawDay.ranges : [])
      .map((range) => ({
        from: normalizeTime(range?.from),
        to: normalizeTime(range?.to),
      }))
      .filter((range) => TIME_RE.test(range.from) && TIME_RE.test(range.to))
      .sort((a, b) => minutesOf(a.from) - minutesOf(b.from));

    for (let i = 0; i < ranges.length; i += 1) {
      const current = ranges[i];
      const fromMin = minutesOf(current.from);
      const toMin = minutesOf(current.to);

      if (!Number.isFinite(fromMin) || !Number.isFinite(toMin) || toMin <= fromMin) {
        this.invalidate(
          "weeklyHours",
          `Horario inválido para día ${weekday}: ${current.from}-${current.to}.`
        );
        continue;
      }

      const previous = ranges[i - 1];
      if (previous && minutesOf(previous.to) > fromMin) {
        this.invalidate(
          "weeklyHours",
          `Los rangos horarios del día ${weekday} no pueden superponerse.`
        );
      }
    }

    byWeekday.set(weekday, {
      weekday,
      enabled: rawDay?.enabled !== false,
      ranges,
    });
  }

  this.weeklyHours = [...byWeekday.values()].sort(
    (a, b) => a.weekday - b.weekday
  );
});

serviceDefinitionSchema.index({ active: 1, catalogVisible: 1, sortOrder: 1 });
serviceDefinitionSchema.index({ capacityGroup: 1, active: 1 });

export const CORE_SERVICE_DEFINITIONS = [
  {
    serviceKey: "EP",
    name: "Entrenamiento Personal",
    description:
      "DUO TRAINING · Entrenamiento personalizado con seguimiento profesional.",
    category: "training",
    active: true,
    catalogVisible: true,
    purchasable: true,
    reservable: true,
    recurringPlanEnabled: true,
    fixedScheduleEnabled: true,
    waitlistEnabled: true,
    capacityGroup: "TRAINING",
    duration: 60,
    slotMinutes: 60,
    minBookingMinutes: 30,
    maxAdvanceDays: 30,
    cancellationCutoffHours: 1,
    sortOrder: 10,
    weeklyHours: [
      { weekday: 1, ranges: [{ from: "07:00", to: "21:00" }] },
      { weekday: 2, ranges: [{ from: "07:00", to: "21:00" }] },
      { weekday: 3, ranges: [{ from: "07:00", to: "21:00" }] },
      { weekday: 4, ranges: [{ from: "07:00", to: "21:00" }] },
      { weekday: 5, ranges: [{ from: "07:00", to: "21:00" }] },
    ],
    legacy: false,
  },
  {
    serviceKey: "RA",
    name: "Rehabilitación Activa",
    description:
      "DUO PERFORMANCE · Rehabilitación activa con trabajo progresivo según objetivos terapéuticos.",
    category: "performance",
    active: true,
    catalogVisible: true,
    purchasable: true,
    reservable: true,
    recurringPlanEnabled: true,
    fixedScheduleEnabled: true,
    waitlistEnabled: true,
    capacityGroup: "PERFORMANCE",
    duration: 60,
    slotMinutes: 60,
    minBookingMinutes: 24 * 60,
    maxAdvanceDays: 30,
    cancellationCutoffHours: 4,
    sortOrder: 20,
    weeklyHours: [
      { weekday: 1, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 2, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 3, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 4, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 5, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
    ],
    legacy: false,
  },
  {
    serviceKey: "RF",
    name: "Reeducación Funcional",
    description:
      "DUO PERFORMANCE · Reeducación funcional orientada a recuperar función, control y movimiento.",
    category: "performance",
    active: true,
    catalogVisible: true,
    purchasable: true,
    reservable: true,
    recurringPlanEnabled: true,
    fixedScheduleEnabled: true,
    waitlistEnabled: true,
    capacityGroup: "PERFORMANCE",
    duration: 60,
    slotMinutes: 60,
    minBookingMinutes: 24 * 60,
    maxAdvanceDays: 30,
    cancellationCutoffHours: 4,
    sortOrder: 30,
    weeklyHours: [
      { weekday: 1, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 2, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 3, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 4, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 5, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
    ],
    legacy: false,
  },
  {
    serviceKey: "SYN",
    name: "Synergy",
    description:
      "DUO PERFORMANCE · Trabajo integral dentro del salón Performance.",
    category: "performance",
    active: true,
    catalogVisible: true,
    purchasable: true,
    reservable: true,
    recurringPlanEnabled: true,
    fixedScheduleEnabled: true,
    waitlistEnabled: true,
    capacityGroup: "PERFORMANCE",
    duration: 60,
    slotMinutes: 60,
    minBookingMinutes: 24 * 60,
    maxAdvanceDays: 30,
    cancellationCutoffHours: 4,
    sortOrder: 40,
    weeklyHours: [
      { weekday: 1, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 2, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 3, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 4, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
      { weekday: 5, ranges: [{ from: "07:00", to: "13:00" }, { from: "16:00", to: "20:00" }] },
    ],
    legacy: false,
  },

  // Compatibilidad histórica. En el Paso 1 NO aparecen en /services.
  {
    serviceKey: "PE",
    name: "Primera evaluación presencial",
    description: "Evaluación inicial DUO.",
    category: "evaluation",
    active: false,
    catalogVisible: false,
    purchasable: false,
    reservable: false,
    recurringPlanEnabled: false,
    fixedScheduleEnabled: false,
    waitlistEnabled: false,
    capacityGroup: "NONE",
    duration: 60,
    slotMinutes: 60,
    minBookingMinutes: 60,
    maxAdvanceDays: 30,
    cancellationCutoffHours: 1,
    sortOrder: 900,
    weeklyHours: [],
    legacy: true,
  },
  {
    serviceKey: "KD",
    name: "Kinefilaxia Deportiva",
    description: "Servicio histórico de Kinefilaxia Deportiva.",
    category: "performance",
    active: false,
    catalogVisible: false,
    purchasable: false,
    reservable: false,
    recurringPlanEnabled: false,
    fixedScheduleEnabled: false,
    waitlistEnabled: false,
    capacityGroup: "PERFORMANCE",
    duration: 60,
    slotMinutes: 60,
    minBookingMinutes: 24 * 60,
    maxAdvanceDays: 30,
    cancellationCutoffHours: 4,
    sortOrder: 910,
    weeklyHours: [],
    legacy: true,
  },
  {
    serviceKey: "NUT",
    name: "Nutrición",
    description: "Servicio de Nutrición.",
    category: "nutrition",
    active: false,
    catalogVisible: false,
    purchasable: false,
    reservable: false,
    recurringPlanEnabled: false,
    fixedScheduleEnabled: false,
    waitlistEnabled: false,
    capacityGroup: "NONE",
    duration: 60,
    slotMinutes: 60,
    minBookingMinutes: 60,
    maxAdvanceDays: 30,
    cancellationCutoffHours: 1,
    sortOrder: 920,
    weeklyHours: [],
    legacy: true,
  },
];

const ServiceDefinition =
  mongoose.models.ServiceDefinition ||
  mongoose.model("ServiceDefinition", serviceDefinitionSchema);

export default ServiceDefinition;
