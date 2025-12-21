import mongoose from "mongoose";

const historySchema = new mongoose.Schema(
  {
    action: { type: String, default: "" },
    date: { type: String, default: "" }, // YYYY-MM-DD
    time: { type: String, default: "" }, // HH:mm
    service: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    dni: { type: String, default: "" },
    age: { type: Number, default: null },
    weight: { type: Number, default: null },
    notes: { type: String, default: "" },

    credits: { type: Number, default: 0 },
    role: { type: String, default: "client" }, // "admin" | "client"

    password: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },

    aptoPath: { type: String, default: "" },
    aptoStatus: { type: String, default: "" }, // "uploaded" | "approved" | "rejected"

    photoPath: { type: String, default: "" },

    history: { type: [historySchema], default: [] },

    /* =========================
       DUO+ (membresía mensual)
       ========================= */
    plus: {
      active: { type: Boolean, default: false },
      autoRenew: { type: Boolean, default: false }, // (luego lo conectamos a suscripción MP)
      startedAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null }, // vence en 30 días
    },

      // dentro de userSchema (agregar este bloque)
      membership: {
        tier: { type: String, default: "", uppercase: true, trim: true }, // "PLUS" o ""
        active: { type: Boolean, default: false },
        expiresAt: { type: Date, default: null },

        // reglas
        cancelMinHours: { type: Number, default: 24 }, // BASIC=24, PLUS=12
        cancelLimit: { type: Number, default: 1 },     // BASIC=1, PLUS=2
        cancelsUsed: { type: Number, default: 0 },

        creditsExpireDays: { type: Number, default: 30 }, // BASIC=30, PLUS=40

        // para reset mensual de cancelsUsed
        cycleStartAt: { type: Date, default: null },
      },


    // cancelaciones en ventana de 30 días
    cancelationsUsed: { type: Number, default: 0 },
    cancelationsPeriodStart: { type: Date, default: null },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
export default User;
