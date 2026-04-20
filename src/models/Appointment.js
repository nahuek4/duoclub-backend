import mongoose from "mongoose";

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  NUT: "Nutrición",
};

const ALLOWED_SERVICE_KEYS = new Set(Object.keys(SERVICE_KEY_TO_NAME));

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const up = raw.toUpperCase().trim();
  if (up === "AR") return "RA";
  if (ALLOWED_SERVICE_KEYS.has(up)) return up;

  const s = stripAccents(raw).toLowerCase().trim();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("nutric")) return "NUT";

  return "";
}

function serviceKeyToName(serviceKey) {
  return SERVICE_KEY_TO_NAME[normalizeServiceKey(serviceKey)] || "";
}

function applyNormalizedServiceFields(target) {
  if (!target || typeof target !== "object") return target;

  const normalizedKey = normalizeServiceKey(target.serviceKey || target.service);
  if (!normalizedKey) return target;

  target.serviceKey = normalizedKey;
  target.service = serviceKeyToName(normalizedKey);
  return target;
}

function normalizeUpdatePayload(update) {
  if (!update || typeof update !== "object") return update;

  const next = { ...update };

  if (next.$set && typeof next.$set === "object") {
    next.$set = { ...next.$set };
    applyNormalizedServiceFields(next.$set);
  }

  if (next.$setOnInsert && typeof next.$setOnInsert === "object") {
    next.$setOnInsert = { ...next.$setOnInsert };
    applyNormalizedServiceFields(next.$setOnInsert);
  }

  const topLevelHasService =
    Object.prototype.hasOwnProperty.call(next, "service") ||
    Object.prototype.hasOwnProperty.call(next, "serviceKey");

  if (topLevelHasService) {
    applyNormalizedServiceFields(next);
  }

  return next;
}

const appointmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    date: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    time: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{2}:\d{2}$/,
    },

    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: [...ALLOWED_SERVICE_KEYS],
      index: true,
    },

    // Se mantiene por compatibilidad y para mostrar en UI/mails.
    // La fuente de verdad pasa a ser serviceKey.
    service: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ["reserved", "cancelled", "completed"],
      default: "reserved",
    },

    coach: { type: String, default: "" },

    completedAt: { type: Date, default: null },

    creditLotId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    creditExpiresAt: { type: Date, default: null },

    reminder24hSentAt: { type: Date, default: null },
    reminder24hLastError: { type: String, default: "" },

    creditExpiry15dReminderSentAt: { type: Date, default: null },
    creditExpiry15dReminderLastError: { type: String, default: "" },

    creditExpiry7dReminderSentAt: { type: Date, default: null },
    creditExpiry7dReminderLastError: { type: String, default: "" },

    creditExpiredProcessedAt: { type: Date, default: null },

    createdByRole: {
      type: String,
      enum: ["client", "guest", "staff", "profesor", "admin", ""],
      default: "",
    },

    createdByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    assignedManually: {
      type: Boolean,
      default: false,
    },

    waitlistEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WaitlistEntry",
      default: null,
    },

    assignedFromWaitlist: {
      type: Boolean,
      default: false,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancelReason: {
      type: String,
      default: "",
      trim: true,
    },

    refundApplied: {
      type: Boolean,
      default: false,
    },

    refundMode: {
      type: String,
      default: "",
      trim: true,
    },

    refundReason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

appointmentSchema.pre("validate", function appointmentPreValidate(next) {
  const normalizedKey = normalizeServiceKey(this.serviceKey || this.service);

  if (!normalizedKey) {
    this.invalidate(
      "serviceKey",
      "serviceKey inválido. Debe ser uno de: PE, EP, RA, RF, NUT."
    );
    return next();
  }

  this.serviceKey = normalizedKey;
  this.service = serviceKeyToName(normalizedKey);
  return next();
});

for (const hook of ["updateOne", "updateMany", "findOneAndUpdate"]) {
  appointmentSchema.pre(hook, function appointmentPreUpdate(next) {
    const update = this.getUpdate?.();
    const normalized = normalizeUpdatePayload(update);
    if (normalized) this.setUpdate(normalized);
    return next();
  });
}

appointmentSchema.index(
  { date: 1, time: 1, serviceKey: 1, status: 1 },
  {
    partialFilterExpression: {
      status: "reserved",
      serviceKey: { $ne: "EP" },
    },
  }
);

appointmentSchema.index(
  { date: 1, time: 1, user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "reserved" } }
);

appointmentSchema.index({
  status: 1,
  date: 1,
  time: 1,
  reminder24hSentAt: 1,
});

appointmentSchema.index({
  status: 1,
  creditExpiresAt: 1,
  creditExpiry15dReminderSentAt: 1,
  creditExpiry7dReminderSentAt: 1,
  creditExpiredProcessedAt: 1,
});

appointmentSchema.index({ waitlistEntryId: 1 });
appointmentSchema.index({ createdByUser: 1, createdAt: -1 });
appointmentSchema.index({ assignedManually: 1, assignedFromWaitlist: 1 });
appointmentSchema.index({ cancelledAt: 1, cancelledBy: 1 });

const Appointment =
  mongoose.models.Appointment ||
  mongoose.model("Appointment", appointmentSchema);

export default Appointment;
