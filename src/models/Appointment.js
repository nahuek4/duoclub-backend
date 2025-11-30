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
    // Servicio: "Entrenamiento Personal", "Running", etc.
    service: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["reserved", "cancelled"], // 👈 usamos SIEMPRE estos dos valores
      default: "reserved",
    },
    coach: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// índice para evitar duplicados por día+hora+servicio+estado reservado
appointmentSchema.index(
  { date: 1, time: 1, service: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "reserved" } }
);

const Appointment = mongoose.model("Appointment", appointmentSchema);
export default Appointment;
