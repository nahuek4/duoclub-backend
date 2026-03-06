import mongoose from "mongoose";

const fixedScheduleItemSchema = new mongoose.Schema(
  {
    weekday: {
      type: Number,
      required: true,
      min: 1,
      max: 5, // 1=lunes ... 5=viernes
    },
    time: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const fixedScheduleSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    service: {
      type: String,
      required: true,
      trim: true,
    },

    items: {
      type: [fixedScheduleItemSchema],
      default: [],
    },

    months: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },

    startDate: {
      type: String,
      required: true, // YYYY-MM-DD
    },

    endDate: {
      type: String,
      required: true, // YYYY-MM-DD
    },

    notes: {
      type: String,
      default: "",
    },

    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

fixedScheduleSchema.index({ user: 1, active: 1 });

const FixedSchedule = mongoose.model("FixedSchedule", fixedScheduleSchema);
export default FixedSchedule;