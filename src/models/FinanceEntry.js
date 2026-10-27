import mongoose from "mongoose";
const financeEntrySchema = new mongoose.Schema({
  section: {
    type: String,
    default: "General",
    maxlength: 80
  },
  paidBy: {
    type: String,
    default: "Caja/DUO",
    maxlength: 80
  },
  revision: {
    type: Number,
    default: 0
  },
  history: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  type: {
    type: String,
    enum: ["income", "expense"],
    required: true
  },
  amountCents: {
    type: Number,
    required: true,
    min: 1,
    max: 1000000000000,
    validate: Number.isSafeInteger
  },
  date: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },
  category: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  description: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500
  },
  method: {
    type: String,
    enum: ["CASH", "TRANSFER", "MP", "OTHER"],
    required: true
  },
  reference: {
    type: String,
    default: "",
    trim: true,
    maxlength: 120
  },
  requestKey: {
    type: String,
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  status: {
    type: String,
    enum: ["active", "void"],
    default: "active"
  },
  voidedAt: {
    type: Date,
    default: null
  },
  voidedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  voidReason: {
    type: String,
    default: "",
    maxlength: 300
  }
}, {
  timestamps: true
});
financeEntrySchema.index({
  createdBy: 1,
  requestKey: 1
}, {
  unique: true
});
financeEntrySchema.index({
  date: -1,
  status: 1
});
export default mongoose.models.FinanceEntry || mongoose.model("FinanceEntry", financeEntrySchema);
