// backend/src/models/Appointment.js
import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    date: { type: String, required: true }, // "YYYY-MM-DD"
    time: { type: String, required: true }, // "HH:mm"

    service: { type: String, required: true },

    status: {
      type: String,
      enum: ["reserved", "cancelled"],
      default: "reserved",
    },

    coach: { type: String, default: "" },

    // ✅ NUEVO: de qué lote se descontó el crédito (para devolverlo al cancelar)
    creditLotId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // ✅ NUEVO: vencimiento del crédito usado (debug/UI)
    creditExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Evita duplicado por día+hora+servicio (solo reserved)
appointmentSchema.index(
  { date: 1, time: 1, service: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "reserved" } }
);

// Evita que el mismo usuario reserve 2 veces el mismo horario
appointmentSchema.index(
  { date: 1, time: 1, user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "reserved" } }
);

const Appointment = mongoose.model("Appointment", appointmentSchema);
export default Appointment;
