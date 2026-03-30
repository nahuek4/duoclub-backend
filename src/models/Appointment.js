import mongoose from "mongoose";

const EP_KEY = "Entrenamiento Personal";

const appointmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    date: { type: String, required: true }, // YYYY-MM-DD
    time: { type: String, required: true }, // HH:mm

    service: { type: String, required: true },

    status: {
      type: String,
      enum: ["reserved", "cancelled", "completed"],
      default: "reserved",
    },

    coach: { type: String, default: "" },

    completedAt: { type: Date, default: null },

    creditLotId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    creditExpiresAt: { type: Date, default: null },

    reminder24hSentAt: { type: Date, default: null },
    reminder24hLastError: { type: String, default: "" },

    creditExpiry15dReminderSentAt: { type: Date, default: null },
    creditExpiry15dReminderLastError: { type: String, default: "" },

    creditExpiry7dReminderSentAt: { type: Date, default: null },
    creditExpiry7dReminderLastError: { type: String, default: "" },

    creditExpiredProcessedAt: { type: Date, default: null },

    createdByRole: {
      type: String,
      enum: ["client", "guest", "staff", "profesor", "admin", ""],
      default: "",
    },

    createdByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    assignedManually: {
      type: Boolean,
      default: false,
    },

    waitlistEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WaitlistEntry",
      default: null,
    },

    assignedFromWaitlist: {
      type: Boolean,
      default: false,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancelReason: {
      type: String,
      default: "",
      trim: true,
    },

    refundApplied: {
      type: Boolean,
      default: false,
    },

    refundMode: {
      type: String,
      default: "",
      trim: true,
    },

    refundReason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

appointmentSchema.index(
  { date: 1, time: 1, service: 1, status: 1 },
  {
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

appointmentSchema.index({
  status: 1,
  date: 1,
  time: 1,
  reminder24hSentAt: 1,
});

appointmentSchema.index({
  status: 1,
  creditExpiresAt: 1,
  creditExpiry15dReminderSentAt: 1,
  creditExpiry7dReminderSentAt: 1,
  creditExpiredProcessedAt: 1,
});

appointmentSchema.index({ waitlistEntryId: 1 });
appointmentSchema.index({ createdByUser: 1, createdAt: -1 });
appointmentSchema.index({ assignedManually: 1, assignedFromWaitlist: 1 });
appointmentSchema.index({ cancelledAt: 1, cancelledBy: 1 });

const Appointment =
  mongoose.models.Appointment ||
  mongoose.model("Appointment", appointmentSchema);

export default Appointment;