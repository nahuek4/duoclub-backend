// backend/src/models/User.js
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
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
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

    // ✅ Verificación y aprobación (NECESARIO para el token de verificación)
    emailVerified: { type: Boolean, default: false },

    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    emailVerificationToken: { type: String, default: "" },
    emailVerificationExpires: { type: Date, default: null },

    // ===== Membresía DUO+ (usuario, no servicio) =====
    membership: {
      tier: { type: String, default: "basic", enum: ["basic", "plus"] },
      activeUntil: { type: Date, default: null },

      cancelHours: { type: Number, default: 24 }, // basic 24 | plus 12
      cancelsLeft: { type: Number, default: 1 }, // basic 1 | plus 2
      creditsExpireDays: { type: Number, default: 30 }, // basic 30 | plus 40
    },

    // ===== Créditos por lote (para vencimiento real) =====
    // cada compra crea un lote con remaining + expiresAt
    creditLots: [
      {
        amount: { type: Number, default: 0 },
        remaining: { type: Number, default: 0 },
        expiresAt: { type: Date, default: null },
        source: { type: String, default: "" }, // "mp" | "cash" | "refund" | etc
        orderId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Order",
          default: null,
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // cancelaciones en ventana de 30 días
    cancelationsUsed: { type: Number, default: 0 },
    cancelationsPeriodStart: { type: Date, default: null },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
export default User;
