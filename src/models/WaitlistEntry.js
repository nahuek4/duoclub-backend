// backend/src/models/WaitlistEntry.js
import mongoose from "mongoose";

const EP_NAME = "Entrenamiento Personal";

const waitlistEntrySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    date: { type: String, required: true }, // YYYY-MM-DD
    time: { type: String, required: true }, // HH:mm
    service: { type: String, required: true, default: EP_NAME },

    status: {
      type: String,
      enum: ["waiting", "notified", "claimed", "expired", "cancelled"],
      default: "waiting",
    },

    // Token para “claim” desde el mail / modal
    notifyToken: { type: String, default: "" },
    notifyTokenExpiresAt: { type: Date, default: null },

    notifiedAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },

    lastNotifyError: { type: String, default: "" },
  },
  { timestamps: true }
);

// 1 waitlist activo por usuario por slot (no importa cuántas veces intente)
waitlistEntrySchema.index(
  { user: 1, date: 1, time: 1, service: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["waiting", "notified"] } },
  }
);

// búsquedas por slot
waitlistEntrySchema.index({ date: 1, time: 1, service: 1, status: 1 });

const WaitlistEntry = mongoose.model("WaitlistEntry", waitlistEntrySchema);
export default WaitlistEntry;
