// backend/src/models/Evaluation.js
import mongoose from "mongoose";

const evaluationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Ej: "SFMA_TOP_TIER" (después sumamos más tipos)
    type: { type: String, required: true, uppercase: true, trim: true },

    // Nombre amigable opcional para mostrar en UI (ej: "SFMA Top Tier")
    title: { type: String, default: "", trim: true },

    // Acá guardamos TODA la data del formulario (SFMA / lo que sea)
    scoring: { type: Object, default: {} },

    notes: { type: String, default: "" },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Índices para que el historial vuele
evaluationSchema.index({ user: 1, createdAt: -1 });
evaluationSchema.index({ type: 1, createdAt: -1 });

const Evaluation = mongoose.model("Evaluation", evaluationSchema);
export default Evaluation;
