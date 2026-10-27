import mongoose from "mongoose";
const schema = new mongoose.Schema({
  section: {
    type: String,
    enum: ["General", "Training", "Performance"],
    default: "General"
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  date: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },
  kind: {
    type: String,
    required: true,
    maxlength: 80
  },
  minutes: {
    type: Number,
    required: true,
    min: 1,
    max: 1440,
    validate: Number.isInteger
  },
  note: {
    type: String,
    default: "",
    maxlength: 500
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  requestKey: {
    type: String,
    required: true
  },
  revision: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ["active", "void"],
    default: "active"
  },
  history: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  }
}, {
  timestamps: true
});
schema.index({
  createdBy: 1,
  requestKey: 1
}, {
  unique: true
});
schema.index({
  user: 1,
  date: -1,
  status: 1
});
export default mongoose.models.FinanceHours || mongoose.model("FinanceHours", schema);
