// backend/src/models/Appointment.js
import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Fecha en formato "YYYY-MM-DD"
    date: {
      type: String,
      required: true,
    },
    // Hora en formato "HH:mm"
    time: {
      type: String,
      required: true,
    },
    // Servicio
    service: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["reserved", "cancelled"],
      default: "reserved",
    },
    coach: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// ✅ Evita duplicado por día+hora+servicio (solo si status="reserved")
appointmentSchema.index(
  { date: 1, time: 1, service: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "reserved" } }
);

// ✅ NUEVO: evita que el mismo usuario reserve 2 veces el mismo horario (cualquier servicio)
appointmentSchema.index(
  { date: 1, time: 1, user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "reserved" } }
);

const Appointment = mongoose.model("Appointment", appointmentSchema);
export default Appointment;
