import mongoose from "mongoose";

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
    serviceKey: { type: String, default: "" },
    qty: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const creditLotSchema = new mongoose.Schema(
  {
    serviceKey: { type: String, default: "EP", uppercase: true, trim: true },
    amount: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
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

    credits: { type: Number, default: 0 },

    role: {
      type: String,
      default: "client",
      enum: ["admin", "profesor", "client", "guest"],
    },

    password: { type: String, required: requiredIfNotGuest, default: "" },

    mustChangePassword: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },

    aptoPath: { type: String, default: "" },
    aptoStatus: { type: String, default: "" },
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
    },

    creditLots: { type: [creditLotSchema], default: [] },

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

userSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: "string", $ne: "" } },
  }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;