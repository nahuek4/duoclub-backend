import mongoose from "mongoose";

const evaluationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Ej: "SFMA_TOP_TIER"
    type: { type: String, required: true, uppercase: true, trim: true },

    // Nombre amigable (UI)
    title: { type: String, default: "", trim: true },

    // Guarda TODA la data del formulario
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

evaluationSchema.index({ user: 1, createdAt: -1 });
evaluationSchema.index({ type: 1, createdAt: -1 });

const Evaluation = mongoose.model("Evaluation", evaluationSchema);
export default Evaluation;
