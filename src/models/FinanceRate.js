import mongoose from "mongoose";
const schema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  month: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}$/
  },
  kind: {
    type: String,
    required: true,
    maxlength: 80
  },
  rateCents: {
    type: Number,
    required: true,
    min: 0,
    max: 1000000000,
    validate: Number.isSafeInteger
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  }
}, {
  timestamps: true
});
schema.index({
  user: 1,
  month: 1,
  kind: 1
}, {
  unique: true
});
export default mongoose.models.FinanceRate || mongoose.model("FinanceRate", schema);
