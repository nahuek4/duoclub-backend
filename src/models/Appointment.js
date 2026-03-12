import mongoose from "mongoose";

const EP_KEY = "Entrenamiento Personal";

const appointmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    date: { type: String, required: true },
    time: { type: String, required: true },

    service: { type: String, required: true },

    status: {
      type: String,
      enum: ["reserved", "cancelled"],
      default: "reserved",
    },

    coach: { type: String, default: "" },

    creditLotId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    creditExpiresAt: { type: Date, default: null },

    reminder24hSentAt: { type: Date, default: null },
    reminder24hLastError: { type: String, default: "" },
  },
  { timestamps: true }
);

appointmentSchema.index(
  { date: 1, time: 1, service: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: "reserved",
      service: { $ne: EP_KEY },
    },
  }
);

appointmentSchema.index(
  { date: 1, time: 1, user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "reserved" } }
);

appointmentSchema.index({ status: 1, date: 1, time: 1, reminder24hSentAt: 1 });

const Appointment = mongoose.model("Appointment", appointmentSchema);
export default Appointment;