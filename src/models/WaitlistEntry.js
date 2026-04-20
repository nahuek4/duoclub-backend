import mongoose from "mongoose";

const { Schema } = mongoose;

const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "NUT"]);

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

  const upper = raw.toUpperCase();
  if (upper === "AR") return "RA";
  if (ALLOWED_SERVICE_KEYS.has(upper)) return upper;

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

function getServiceNameFromKey(serviceKey) {
  return SERVICE_KEY_TO_NAME[String(serviceKey || "").toUpperCase().trim()] || "";
}

const WaitlistEntrySchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    date: {
      type: String,
      required: true,
      index: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    time: {
      type: String,
      required: true,
      index: true,
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

    service: {
      type: String,
      required: true,
      default: "Entrenamiento Personal",
      trim: true,
    },

    status: {
      type: String,
      enum: [
        "waiting",
        "notified",
        "claimed",
        "expired",
        "removed",
        "closed",
      ],
      default: "waiting",
      index: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    priorityOrder: {
      type: Number,
      default: 0,
      index: true,
    },

    notifyToken: {
      type: String,
      default: null,
      index: true,
    },

    tokenExpiresAt: {
      type: Date,
      default: null,
    },

    notifiedAt: {
      type: Date,
      default: null,
    },

    claimedAt: {
      type: Date,
      default: null,
    },

    claimedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    assignedAppointmentId: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },

    closedAt: {
      type: Date,
      default: null,
    },

    closeReason: {
      type: String,
      enum: [
        "",
        "MIN_ADVANCE_REACHED",
        "SLOT_FILLED",
        "MANUAL_CLOSE",
        "USER_CANCELLED",
        "SYSTEM_CLEANUP",
      ],
      default: "",
      trim: true,
    },

    removedAt: {
      type: Date,
      default: null,
    },

    removedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdByUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdByRole: {
      type: String,
      enum: ["client", "guest", "staff", "profesor", "admin", ""],
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

WaitlistEntrySchema.pre("validate", function normalizeCanonicalService(next) {
  const resolvedServiceKey =
    normalizeServiceKey(this.serviceKey) || normalizeServiceKey(this.service);

  if (!resolvedServiceKey) {
    return next(new Error("serviceKey inválido."));
  }

  this.serviceKey = resolvedServiceKey;

  if (!String(this.service || "").trim()) {
    this.service = getServiceNameFromKey(resolvedServiceKey);
  } else {
    this.service =
      getServiceNameFromKey(resolvedServiceKey) || String(this.service || "").trim();
  }

  return next();
});

WaitlistEntrySchema.index({
  date: 1,
  time: 1,
  serviceKey: 1,
  status: 1,
  priorityOrder: 1,
  createdAt: 1,
});

WaitlistEntrySchema.index(
  { user: 1, date: 1, time: 1, serviceKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["waiting", "notified"] },
    },
  }
);

WaitlistEntrySchema.index({ status: 1, closedAt: 1, createdAt: 1 });
WaitlistEntrySchema.index({ status: 1, claimedAt: 1 });
WaitlistEntrySchema.index({ assignedAppointmentId: 1 });

const WaitlistEntry =
  mongoose.models.WaitlistEntry ||
  mongoose.model("WaitlistEntry", WaitlistEntrySchema);

export default WaitlistEntry;
