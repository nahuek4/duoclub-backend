import mongoose from "mongoose";

// _id determinista: un registro por usuario/servicio/mes. El índice _id
// existe aun cuando autoIndex esté deshabilitado en producción.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  serviceKey: { type: String, required: true },
  periodKey: { type: String, required: true },
  revision: { type: Number, default: 0 },
  generatedAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  sendingAt: { type: Date, default: null },
  sendToken: { type: String, default: "" },
  lastError: { type: String, default: "" },
}, { timestamps: true });

export default mongoose.models.FixedScheduleRenewal ||
  mongoose.model("FixedScheduleRenewal", schema);

// Un lock de escritura transaccional compartido serializa las generaciones
// independientes entre workers, incluyendo usuarios distintos del mismo cupo.
const lockSchema = new mongoose.Schema({ _id: String, revision: { type: Number, default: 0 } });
export const FixedScheduleRenewalLock = mongoose.models.FixedScheduleRenewalLock ||
  mongoose.model("FixedScheduleRenewalLock", lockSchema);
