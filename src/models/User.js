import mongoose from "mongoose";

const ALLOWED_SERVICE_KEYS = ["PE", "EP", "RA", "RF", "KD", "NUT"];
const ALLOWED_SERVICE_KEYS_SET = new Set(ALLOWED_SERVICE_KEYS);

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  NUT: "Nutrición",
};

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKeyInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const up = raw.toUpperCase().trim();
  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (ALLOWED_SERVICE_KEYS_SET.has(up)) return up;

  const s = stripAccents(raw).toLowerCase().trim();
  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("nutric")) return "NUT";

  return "";
}

function resolveServiceName(serviceKey, fallback = "") {
  const normalized = normalizeServiceKeyInput(serviceKey);
  if (normalized) return SERVICE_KEY_TO_NAME[normalized] || normalized;
  return String(fallback || "").trim();
}

const historySchema = new mongoose.Schema(
  {
    action: { type: String, default: "" },
    title: { type: String, default: "" },
    message: { type: String, default: "" },
    field: { type: String, default: "" },
    date: { type: String, default: "" }, // YYYY-MM-DD
    time: { type: String, default: "" }, // HH:mm
    service: { type: String, default: "" },
    serviceName: { type: String, default: "" },
    serviceKey: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
      validate: {
        validator(v) {
          return !v || ALLOWED_SERVICE_KEYS_SET.has(String(v || "").toUpperCase().trim());
        },
        message: "serviceKey inválido en history.",
      },
    },
    qty: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

historySchema.pre("validate", function () {
  const normalized = normalizeServiceKeyInput(this.serviceKey || this.serviceName || this.service);

  if (normalized) {
    this.serviceKey = normalized;
    const displayName = SERVICE_KEY_TO_NAME[normalized] || "";

    if (!String(this.serviceName || "").trim()) this.serviceName = displayName;
    if (!String(this.service || "").trim()) this.service = displayName;
  }
});

const creditLotSchema = new mongoose.Schema(
  {
    serviceKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ALLOWED_SERVICE_KEYS,
    },
    serviceName: { type: String, default: "", trim: true },
    amount: { type: Number, default: 0, min: 0 },
    remaining: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, default: null },
    source: { type: String, default: "" },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

creditLotSchema.pre("validate", function () {
  const normalized = normalizeServiceKeyInput(this.serviceKey || this.serviceName);

  if (!normalized) {
    throw new Error("creditLot.serviceKey inválido o faltante.");
  }

  this.serviceKey = normalized;
  this.serviceName = resolveServiceName(normalized, this.serviceName);

  const amount = Number(this.amount || 0);
  const remaining = Number(this.remaining || 0);

  this.amount = Math.max(0, amount);
  this.remaining = Math.max(0, Math.min(this.amount, remaining));
});


const medicalClearanceSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      default: "not_submitted",
      enum: ["not_submitted", "pending_review", "approved", "rejected", "suspended"],
    },
    startedAt: { type: Date, default: Date.now },
    dueAt: {
      type: Date,
      default() {
        const d = new Date();
        d.setDate(d.getDate() + 30);
        return d;
      },
    },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    lastReminder10At: { type: Date, default: null },
    lastReminder20At: { type: Date, default: null },
    lastReminder30At: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

function createDefaultMedicalClearance() {
  const startedAt = new Date();
  const dueAt = new Date(startedAt);
  dueAt.setDate(dueAt.getDate() + 30);
  return {
    status: "not_submitted",
    startedAt,
    dueAt,
    approvedAt: null,
    rejectedAt: null,
    suspendedAt: null,
    lastReminder10At: null,
    lastReminder20At: null,
    lastReminder30At: null,
    lastCheckedAt: null,
    notes: "",
  };
}

const clinicalNoteSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    author: { type: String, default: "" },
    text: { type: String, default: "" },
  },
  { _id: false }
);

/* ============================================
   PLAN MENSUAL
============================================ */
function makeMonthlyPlanWeek() {
  return new mongoose.Schema(
    {
      weekNumber: { type: Number, default: 1 },
      series: { type: String, default: "" },
      reps: { type: String, default: "" },
      rir: { type: String, default: "" },
    },
    { _id: false }
  );
}

function makeMonthlyPlanRow() {
  return new mongoose.Schema(
    {
      exercise: { type: String, default: "" },
      weekCells: {
        1: { type: [String], default: ["", "", "", ""] },
        2: { type: [String], default: ["", "", "", ""] },
        3: { type: [String], default: ["", "", "", ""] },
        4: { type: [String], default: ["", "", "", ""] },
      },
    },
    { _id: false }
  );
}

const monthlyPlanSectionSchema = new mongoose.Schema(
  {
    key: { type: String, default: "B2" },
    rows: { type: [makeMonthlyPlanRow()], default: [] },
  },
  { _id: false }
);

const monthlyPlanDaySchema = new mongoose.Schema(
  {
    dayNumber: { type: Number, default: 1 },
    sections: { type: [monthlyPlanSectionSchema], default: [] },
  },
  { _id: false }
);

const monthlyPlanSchema = new mongoose.Schema(
  {
    meta: {
      fullName: { type: String, default: "" },
      age: { type: String, default: "" },
      weight: { type: String, default: "" },
      height: { type: String, default: "" },
      healthConditions: { type: String, default: "" },
      trainingPeriod: { type: String, default: "" },
      objective: { type: String, default: "" },
      weeklyFrequency: { type: String, default: "" },
      startDate: { type: String, default: "" },
      mesocycleNumber: { type: String, default: "" },
      observations: { type: String, default: "" },
    },

    weeks: { type: [makeMonthlyPlanWeek()], default: [] },
    days: { type: [monthlyPlanDaySchema], default: [] },

    footer: {
      activation: { type: String, default: "Plan del día." },
      finisher: {
        type: String,
        default: "A criterio de cada entrenador (metabólico, accesorios).",
      },
      cooldown: {
        type: String,
        default: "Plan del día o estiramiento comunitario.",
      },
    },

    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: "" },
  },
  { _id: false }
);

function createDefaultMonthlyPlan() {
  const makeWeek = (weekNumber) => ({
    weekNumber,
    series: "",
    reps: "",
    rir: "",
  });

  const makeRow = () => ({
    exercise: "",
    weekCells: {
      1: ["", "", "", ""],
      2: ["", "", "", ""],
      3: ["", "", "", ""],
      4: ["", "", "", ""],
    },
  });

  const makeSection = (key) => ({
    key,
    rows: [makeRow(), makeRow(), makeRow()],
  });

  const makeDay = (dayNumber) => ({
    dayNumber,
    sections: [makeSection("B2"), makeSection("B3")],
  });

  return {
    meta: {
      fullName: "",
      age: "",
      weight: "",
      height: "",
      healthConditions: "",
      trainingPeriod: "",
      objective: "",
      weeklyFrequency: "",
      startDate: "",
      mesocycleNumber: "",
      observations: "",
    },
    weeks: [makeWeek(1), makeWeek(2), makeWeek(3), makeWeek(4)],
    days: [makeDay(1), makeDay(2), makeDay(3)],
    footer: {
      activation: "Plan del día.",
      finisher: "A criterio de cada entrenador (metabólico, accesorios).",
      cooldown: "Plan del día o estiramiento comunitario.",
    },
    updatedAt: null,
    updatedBy: "",
  };
}

function requiredIfNotGuest() {
  return this.role !== "guest";
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },

    email: {
      type: String,
      required: requiredIfNotGuest,
      lowercase: true,
      trim: true,
      default: null,
    },

    phone: {
      type: String,
      required: requiredIfNotGuest,
      trim: true,
      default: "",
    },

    dni: { type: String, default: "" },
    age: { type: Number, default: null },
    weight: { type: Number, default: null },
    notes: { type: String, default: "" },

    healthInsurance: {
      provider: { type: String, default: "", trim: true },
    },

    credits: { type: Number, default: 0 },

    role: {
      type: String,
      default: "client",
      enum: ["admin", "profesor", "staff", "client", "guest"],
    },

    password: { type: String, required: requiredIfNotGuest, default: "" },

    mustChangePassword: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },
    suspendedReason: { type: String, default: "", trim: true },
    suspendedAt: { type: Date, default: null },

    aptoPath: { type: String, default: "" },
    aptoStatus: {
      type: String,
      default: "",
      enum: ["", "not_submitted", "uploaded", "pending_review", "approved", "rejected"],
    },
    aptoCompletedAt: { type: Date, default: null },
    medicalClearance: {
      type: medicalClearanceSchema,
      default: createDefaultMedicalClearance,
    },
    photoPath: { type: String, default: "" },

    history: { type: [historySchema], default: [] },
    clinicalNotes: { type: [clinicalNoteSchema], default: [] },

    emailVerified: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    emailVerificationToken: { type: String, default: "" },
    emailVerificationExpires: { type: Date, default: null },

    membership: {
      tier: { type: String, default: "basic", enum: ["basic", "plus"] },
      activeUntil: { type: Date, default: null },
      creditsExpireDays: { type: Number, default: 30 },
      cancelHours: { type: Number, default: 24 },
      cancelsLeft: { type: Number, default: 1 },
    },

    creditLots: { type: [creditLotSchema], default: [] },

    monthlyAutomation: {
      lastMonthlyResetMonthKey: { type: String, default: "" },
      lastRunAt: { type: Date, default: null },
    },

    monthlyPlan: {
      type: monthlyPlanSchema,
      default: createDefaultMonthlyPlan,
    },

    welcomeApprovedEmailSentAt: { type: Date, default: null },

    firstEvaluationCompleted: { type: Boolean, default: false },
    firstEvaluationCompletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.pre("validate", function () {
  if (!this.healthInsurance || typeof this.healthInsurance !== "object") {
    this.healthInsurance = { provider: "" };
  }

  this.healthInsurance.provider = String(
    this.healthInsurance.provider || ""
  ).trim();

  if (!this.medicalClearance || typeof this.medicalClearance !== "object") {
    this.medicalClearance = createDefaultMedicalClearance();
  }

  if (!this.medicalClearance.startedAt) {
    this.medicalClearance.startedAt = this.createdAt || new Date();
  }

  if (!this.medicalClearance.dueAt) {
    const due = new Date(this.medicalClearance.startedAt || this.createdAt || Date.now());
    due.setDate(due.getDate() + 30);
    this.medicalClearance.dueAt = due;
  }

  const aptoStatus = String(this.aptoStatus || "").toLowerCase().trim();
  const hasLegacyCompletedApto = !!this.aptoCompletedAt || String(this.aptoPath || "") === "ADMIN_COMPLETED_APTO";

  if ((aptoStatus === "approved" || hasLegacyCompletedApto) && this.medicalClearance.status !== "approved") {
    this.medicalClearance.status = "approved";
    this.medicalClearance.approvedAt = this.medicalClearance.approvedAt || this.aptoCompletedAt || new Date();
  }

  if (this.medicalClearance.status === "approved") {
    this.aptoStatus = "approved";
  } else if (this.medicalClearance.status === "pending_review") {
    this.aptoStatus = this.aptoStatus || "pending_review";
  } else if (this.medicalClearance.status === "rejected") {
    this.aptoStatus = "rejected";
  }

  if (!this.suspended) {
    this.suspendedReason = "";
    this.suspendedAt = null;
  } else if (!this.suspendedAt) {
    this.suspendedAt = new Date();
  }

  if (Array.isArray(this.history)) {
    this.history = this.history.map((item) => {
      if (!item) return item;
      const normalized = normalizeServiceKeyInput(item.serviceKey || item.serviceName || item.service);
      if (!normalized) return item;

      const displayName = SERVICE_KEY_TO_NAME[normalized] || "";
      if (!item.serviceKey) item.serviceKey = normalized;
      if (!item.serviceName) item.serviceName = displayName;
      if (!item.service) item.service = displayName;
      return item;
    });
  }

  if (Array.isArray(this.creditLots)) {
    this.creditLots = this.creditLots.map((lot) => {
      if (!lot) return lot;
      const normalized = normalizeServiceKeyInput(lot.serviceKey || lot.serviceName);
      if (normalized) {
        lot.serviceKey = normalized;
        if (!lot.serviceName) lot.serviceName = SERVICE_KEY_TO_NAME[normalized] || normalized;
      }
      return lot;
    });
  }
});

userSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: "string", $ne: "" } },
  }
);

userSchema.index({ "creditLots.serviceKey": 1, createdAt: -1 });
userSchema.index({ "history.serviceKey": 1, createdAt: -1 });

const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
