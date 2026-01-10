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
    serviceKey: { type: String, default: "ALL", uppercase: true, trim: true }, // EP/AR/RA/NUT o ALL
    amount: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
    source: { type: String, default: "" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
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

// Helpers para required condicional (guest vs client/admin)
function requiredIfNotGuest() {
  return this.role !== "guest";
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },

    // ✅ Email NO obligatorio para guest
    // ✅ default NULL (NO ""), para que el índice único no choque
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

    // cache (se recalcula desde lots)
    credits: { type: Number, default: 0 },

    role: { type: String, default: "client", enum: ["admin", "client", "guest"] },

    password: { type: String, required: requiredIfNotGuest, default: "" },

    mustChangePassword: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },

    aptoPath: { type: String, default: "" },
    aptoStatus: { type: String, default: "" }, // "uploaded" | "approved" | "rejected"
    photoPath: { type: String, default: "" },

    history: { type: [historySchema], default: [] },

    // ✅ existe (lo usás en /users/:id/clinical-notes)
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

      // ✅ Se elimina todo lo de "límite de cancelaciones".
      // Solo dejamos lo que afecta vencimiento de créditos (si querés seguir distinguiendo Basic vs Plus)
      creditsExpireDays: { type: Number, default: 30 },
    },

    creditLots: { type: [creditLotSchema], default: [] },
  },
  { timestamps: true }
);

// ✅ índice único REAL solo si email es string y no vacío
userSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: "string", $ne: "" } },
  }
);

const User = mongoose.model("User", userSchema);
export default User;
