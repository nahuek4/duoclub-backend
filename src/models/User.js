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
    serviceKey: { type: String, default: "EP", uppercase: true, trim: true }, // EP/RF/AR/RA/NUT o ALL
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

// Helpers para required condicional (guest vs client/admin)
function requiredIfNotGuest() {
  // `this` es el doc
  return this.role !== "guest";
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },

    // ✅ Email NO obligatorio (por pedido), pero:
    // - para client/admin sigue siendo requerido
    // - para guest puede ser "" o null
    email: {
      type: String,
      required: requiredIfNotGuest,
      unique: true,
      sparse: true, // ✅ permite múltiples docs sin email
      lowercase: true,
      trim: true,
      default: "",
    },

    // ✅ Tel no obligatorio para guest
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

    // ✅ ahora agregamos guest
    role: { type: String, default: "client", enum: ["admin", "client", "guest"] },

    // ✅ password requerida para client/admin.
    // Para guest la vamos a setear igual (random+hash) desde el endpoint.
    password: { type: String, required: requiredIfNotGuest, default: "" },

    mustChangePassword: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },

    aptoPath: { type: String, default: "" },
    aptoStatus: { type: String, default: "" }, // "uploaded" | "approved" | "rejected"

    photoPath: { type: String, default: "" },

    history: { type: [historySchema], default: [] },

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

      cancelHours: { type: Number, default: 24 },
      cancelsLeft: { type: Number, default: 1 },
      creditsExpireDays: { type: Number, default: 30 },
    },

    creditLots: { type: [creditLotSchema], default: [] },

    cancelationsUsed: { type: Number, default: 0 },
    cancelationsPeriodStart: { type: Date, default: null },
  },
  { timestamps: true }
);

// ✅ Index único real (sparse evita choque cuando email = "" / null)
userSchema.index({ email: 1 }, { unique: true, sparse: true });

const User = mongoose.model("User", userSchema);
export default User;
