// backend/src/models/WaitlistEntry.js
import mongoose from "mongoose";

const WaitlistEntrySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    time: { type: String, required: true, index: true }, // HH:mm
    service: { type: String, required: true }, // "Entrenamiento Personal" (EP)

    // waiting -> notified -> claimed | expired | cancelled
    status: { type: String, default: "waiting", index: true },

    // token para “claim” cuando se libera cupo
    notifyToken: { type: String, default: null, index: true },
    notifiedAt: { type: Date, default: null },
    tokenExpiresAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Evita duplicados activos del mismo usuario al mismo slot
WaitlistEntrySchema.index(
  { user: 1, date: 1, time: 1, service: 1, status: 1 },
  { name: "wl_user_slot_status" }
);

export default mongoose.model("WaitlistEntry", WaitlistEntrySchema);
