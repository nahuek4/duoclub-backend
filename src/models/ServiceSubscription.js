// backend/src/models/ServiceSubscription.js
import mongoose from "mongoose";

const RECURRING_SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN", "NUT"];
const RECURRING_SERVICE_KEY_SET = new Set(RECURRING_SERVICE_KEYS);

const SERVICE_KEY_TO_NAME = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

const SUBSCRIPTION_STATUSES = [
  "active",
  "pending_change",
  "suspended",
  "cancelled",
  "terminated_for_non_payment",
];

const PENDING_CHANGE_TYPES = ["change", "suspend", "cancel", "reactivate"];

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
  if (upper === "SYNERGY" || upper === "SINERGIA") return "SYN";
  if (RECURRING_SERVICE_KEY_SET.has(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();
  if (text.includes("entrenamiento") && text.includes("personal")) return "EP";
  if (text.includes("rehabilitacion") && text.includes("activa")) return "RA";
  if (text.includes("reeducacion") && text.includes("funcional")) return "RF";
  if (text.includes("kinefilaxia") || (text.includes("kine") && text.includes("deport"))) return "KD";
  if (text.includes("synergy") || text.includes("sinergia")) return "SYN";
  if (text.includes("nutric")) return "NUT";

  return "";
}

function cleanMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function cleanPositiveInteger(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

const addOnSchema = new mongoose.Schema(
  {
    key: { type: String, default: "", trim: true },
    label: { type: String, required: true, trim: true },
    quantity: {
      type: Number,
      default: 1,
      min: 1,
      validate: {
        validator(value) {
          return Number.isInteger(value) && value > 0;
        },
        message: "La cantidad del adicional debe ser un entero mayor a 0.",
      },
    },
    unitPrice: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const pendingChangeSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: PENDING_CHANGE_TYPES,
      default: "change",
      trim: true,
    },
    effectivePeriodKey: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}$/,
    },
    requestedAt: { type: Date, default: Date.now },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    pricingPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingPlan",
      default: null,
    },
    monthlySessions: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator(value) {
          return value === null || (Number.isInteger(value) && value > 0);
        },
        message: "monthlySessions debe ser null o un entero mayor a 0.",
      },
    },
    price: { type: Number, default: null, min: 0 },
    payMethod: {
      type: String,
      enum: ["", "CASH", "MP"],
      default: "",
      uppercase: true,
      trim: true,
    },
    fixedScheduleIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "FixedSchedule",
      default: [],
    },
    addOns: { type: [addOnSchema], default: [] },
    autoRenew: { type: Boolean, default: true },
    reason: { type: String, default: "", trim: true },
  },
  { _id: false }
);


const bootstrapOrderSnapshotSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    paidAt: { type: Date, default: null },
    sessions: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
    payMethod: {
      type: String,
      enum: ["", "CASH", "MP"],
      default: "",
      uppercase: true,
      trim: true,
    },
  },
  { _id: false }
);

const bootstrapSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ["admin_initialization", "legacy_migration"],
      required: true,
      default: "admin_initialization",
    },
    version: {
      type: String,
      default: "subscriptions-v1-published-plans",
      trim: true,
    },
    batchId: { type: String, required: true, trim: true, index: true },
    initializedAt: { type: Date, default: Date.now },
    initializedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    monthKey: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}$/,
    },
    fixedScheduleIdsAtBootstrap: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "FixedSchedule",
      default: [],
    },
    publishedPricingPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingPlan",
      default: null,
    },
    basePlanSessions: { type: Number, default: 0, min: 0 },
    projectedFixedOccurrences: { type: Number, default: 0, min: 0 },
    extraSessionsRequired: { type: Number, default: 0, min: 0 },
    legacyAvailableSessions: { type: Number, default: 0, min: 0 },
    legacyFixedScheduleDebt: { type: Number, default: 0, min: 0 },
    latestPaidOrder: { type: bootstrapOrderSnapshotSchema, default: null },
    notes: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const serviceSubscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: RECURRING_SERVICE_KEYS,
      index: true,
      set: normalizeServiceKey,
    },

    serviceName: { type: String, default: "", trim: true },

    pricingPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingPlan",
      default: null,
    },

    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      default: "active",
      index: true,
    },

    autoRenew: { type: Boolean, default: true, index: true },

    monthlySessions: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator(value) {
          return Number.isInteger(value) && value > 0;
        },
        message: "monthlySessions debe ser un entero mayor a 0.",
      },
    },

    price: { type: Number, required: true, min: 0 },
    regularPrice: { type: Number, default: 0, min: 0 },
    coveragePrice: { type: Number, default: null, min: 0 },
    coverageApplied: { type: Boolean, default: false },
    coverageReason: { type: String, default: "", trim: true },

    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
      default: "CASH",
    },

    fixedScheduleIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "FixedSchedule",
      default: [],
    },

    addOns: { type: [addOnSchema], default: [] },

    currentPeriodKey: {
      type: String,
      default: "",
      trim: true,
      match: /^$|^\d{4}-\d{2}$/,
      index: true,
    },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    lastRenewedAt: { type: Date, default: null },

    pendingChange: { type: pendingChangeSchema, default: null },

    suspendedAt: { type: Date, default: null },
    suspensionReason: { type: String, default: "", trim: true },
    fixedSlotsProtectedUntil: { type: Date, default: null },

    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: "", trim: true },

    terminatedAt: { type: Date, default: null },
    terminationReason: { type: String, default: "", trim: true },


    bootstrap: { type: bootstrapSchema, default: null },

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

serviceSubscriptionSchema.pre("validate", function normalizeSubscription() {
  this.serviceKey = normalizeServiceKey(this.serviceKey || this.serviceName);

  if (!this.serviceKey) {
    this.invalidate(
      "serviceKey",
      "Servicio recurrente inválido. Valores permitidos: EP, RA, RF, KD, SYN, NUT."
    );
    return;
  }

  this.serviceName = SERVICE_KEY_TO_NAME[this.serviceKey] || this.serviceName || this.serviceKey;
  this.monthlySessions = cleanPositiveInteger(this.monthlySessions, 1);
  this.price = cleanMoney(this.price);
  this.regularPrice = cleanMoney(this.regularPrice || this.price);

  if (this.coveragePrice !== null && this.coveragePrice !== undefined) {
    this.coveragePrice = cleanMoney(this.coveragePrice);
  }

  this.payMethod = String(this.payMethod || "CASH").toUpperCase().trim();

  this.fixedScheduleIds = Array.from(
    new Set((Array.isArray(this.fixedScheduleIds) ? this.fixedScheduleIds : []).map(String))
  );

  this.addOns = (Array.isArray(this.addOns) ? this.addOns : []).map((item) => {
    const quantity = cleanPositiveInteger(item?.quantity, 1);
    const unitPrice = cleanMoney(item?.unitPrice);
    return {
      ...item,
      key: String(item?.key || "").trim(),
      label: String(item?.label || "Adicional").trim(),
      quantity,
      unitPrice,
      totalPrice: cleanMoney(item?.totalPrice || unitPrice * quantity),
    };
  });

  if (this.status === "pending_change" && !this.pendingChange) {
    this.invalidate("pendingChange", "Una suscripción pending_change requiere pendingChange.");
  }

  if (this.pendingChange) {
    this.pendingChange.payMethod = String(this.pendingChange.payMethod || "")
      .toUpperCase()
      .trim();
  }

  if (this.bootstrap) {
    this.bootstrap.batchId = String(this.bootstrap.batchId || "").trim();
    this.bootstrap.version = String(
      this.bootstrap.version || "subscriptions-v1-published-plans"
    ).trim();
    this.bootstrap.notes = String(this.bootstrap.notes || "").trim();

    this.bootstrap.fixedScheduleIdsAtBootstrap = Array.from(
      new Set(
        (Array.isArray(this.bootstrap.fixedScheduleIdsAtBootstrap)
          ? this.bootstrap.fixedScheduleIdsAtBootstrap
          : []
        ).map(String)
      )
    );

    this.bootstrap.basePlanSessions = Math.max(
      0,
      Math.trunc(Number(this.bootstrap.basePlanSessions || 0))
    );
    this.bootstrap.projectedFixedOccurrences = Math.max(
      0,
      Math.trunc(Number(this.bootstrap.projectedFixedOccurrences || 0))
    );
    this.bootstrap.extraSessionsRequired = Math.max(
      0,
      Math.trunc(Number(this.bootstrap.extraSessionsRequired || 0))
    );
    this.bootstrap.legacyAvailableSessions = Math.max(
      0,
      Math.trunc(Number(this.bootstrap.legacyAvailableSessions || 0))
    );
    this.bootstrap.legacyFixedScheduleDebt = Math.max(
      0,
      Math.trunc(Number(this.bootstrap.legacyFixedScheduleDebt || 0))
    );
  }
});

// Una sola suscripción por usuario y servicio. Los períodos históricos viven
// en SubscriptionBillingCycle, por lo que reactivar no crea otra suscripción.
serviceSubscriptionSchema.index(
  { user: 1, serviceKey: 1 },
  { unique: true, name: "subscription_user_service_unique" }
);

serviceSubscriptionSchema.index({ status: 1, autoRenew: 1, currentPeriodKey: 1 });
serviceSubscriptionSchema.index({ "pendingChange.effectivePeriodKey": 1, status: 1 });
serviceSubscriptionSchema.index({ fixedSlotsProtectedUntil: 1, status: 1 });
serviceSubscriptionSchema.index({ "bootstrap.batchId": 1, createdAt: -1 });

const ServiceSubscription =
  mongoose.models.ServiceSubscription ||
  mongoose.model("ServiceSubscription", serviceSubscriptionSchema);

export default ServiceSubscription;
export {
  RECURRING_SERVICE_KEYS,
  SERVICE_KEY_TO_NAME,
  SUBSCRIPTION_STATUSES,
  normalizeServiceKey,
};
