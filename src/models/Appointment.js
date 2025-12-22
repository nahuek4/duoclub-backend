// backend/src/models/Appointment.js
import mongoose from "mongoose";

const EP_KEY = "Entrenamiento Personal";

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

    // ✅ de qué lote se descontó el crédito (para devolverlo al cancelar)
    creditLotId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // ✅ vencimiento del crédito usado (debug/UI)
    creditExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * ✅ IMPORTANTE:
 * Antes tenías un índice único por (date,time,service,status) que
 * ROMPE Entrenamiento Personal, porque EP necesita múltiples cupos
 * en el mismo horario con el mismo "service".
 *
 * Solución:
 * - Mantener “1 por servicio” SOLO para los servicios NO EP
 * - Permitir múltiples EP
 */
appointmentSchema.index(
  { date: 1, time: 1, service: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: "reserved",
      service: { $ne: EP_KEY },
    },
  }
);

// Evita que el mismo usuario reserve 2 veces el mismo horario
appointmentSchema.index(
  { date: 1, time: 1, user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "reserved" } }
);

const Appointment = mongoose.model("Appointment", appointmentSchema);
export default Appointment;
