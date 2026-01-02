import mongoose from "mongoose";

const evaluationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    type: { type: String, required: true, uppercase: true, trim: true }, // "SFMA_TOP_TIER", etc
    title: { type: String, default: "" },

    // scoring libre (SFMA: objeto con keys y L/R)
    scoring: { type: mongoose.Schema.Types.Mixed, default: {} },

    notes: { type: String, default: "" },

    // (opcional) quien la creó (admin)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

evaluationSchema.index({ user: 1, createdAt: -1 });

const Evaluation = mongoose.model("Evaluation", evaluationSchema);
export default Evaluation;
