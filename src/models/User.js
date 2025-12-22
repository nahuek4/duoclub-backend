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

const creditLotSchema = new mongoose.Schema(
  {
    // ✅ NUEVO: servicio asociado al lote
    // EP/RF/AR/RA/NUT o ALL (si algún día vendés créditos “multi-servicio”)
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

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    phone: { type: String, required: true, trim: true },

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

    // ✅ Verificación y aprobación
    emailVerified: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    emailVerificationToken: { type: String, default: "" },
    emailVerificationExpires: { type: Date, default: null },

    // ===== Membresía DUO+ =====
    membership: {
      tier: { type: String, default: "basic", enum: ["basic", "plus"] },
      activeUntil: { type: Date, default: null },

      cancelHours: { type: Number, default: 24 },
      cancelsLeft: { type: Number, default: 1 },
      creditsExpireDays: { type: Number, default: 30 },
    },

    // ===== Créditos por lote =====
    creditLots: { type: [creditLotSchema], default: [] },

    cancelationsUsed: { type: Number, default: 0 },
    cancelationsPeriodStart: { type: Date, default: null },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
export default User;
