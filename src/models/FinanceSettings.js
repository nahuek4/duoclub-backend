import mongoose from "mongoose";
const schema = new mongoose.Schema({
  _id: {
    type: String,
    default: "main"
  },
  categories: {
    type: [String],
    default: ["Alquiler", "Sueldos", "Servicios", "Insumos", "Mantenimiento", "Equipamiento", "Otros"]
  },
  sections: {
    type: [String],
    default: ["General", "Training", "Performance"]
  },
  payers: {
    type: [String],
    default: ["Caja/DUO"]
  },
  hourKinds: {
    type: [String],
    default: ["Gym", "Domicilio", "Feriado", "Administración"]
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }
}, {
  timestamps: true
});
export default mongoose.models.FinanceSettings || mongoose.model("FinanceSettings", schema);
