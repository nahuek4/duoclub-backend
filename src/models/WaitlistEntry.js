// backend/src/models/WaitlistEntry.js
import mongoose from "mongoose";

const waitlistSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    date: { type: String, required: true }, // "YYYY-MM-DD"
    time: { type: String, required: true }, // "HH:mm"
    service: { type: String, required: true }, // normalmente EP_NAME

    status: {
      type: String,
      enum: ["waiting", "notified", "claimed", "cancelled"],
      default: "waiting",
    },

    // cuando se notificó al usuario
    notifiedAt: { type: Date, default: null },

    // token para "claim" (se consume al confirmar)
    notifyToken: { type: String, default: "" },
    notifyTokenExpiresAt: { type: Date, default: null },

    // debug/auditoría
    lastNotifyError: { type: String, default: "" },

    claimedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// ✅ evita que el mismo usuario se anote 2 veces al mismo slot (mientras siga "activa")
waitlistSchema.index(
  { user: 1, date: 1, time: 1, service: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["waiting", "notified"] } },
  }
);

// ✅ ayuda para el scheduler
waitlistSchema.index({ status: 1, date: 1, time: 1, service: 1 });

const WaitlistEntry = mongoose.model("WaitlistEntry", waitlistSchema);
export default WaitlistEntry;
