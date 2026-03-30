import mongoose from "mongoose";

const { Schema } = mongoose;

const WaitlistEntrySchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    date: {
      type: String,
      required: true,
      index: true,
    },

    time: {
      type: String,
      required: true,
      index: true,
    },

    service: {
      type: String,
      required: true,
      default: "Entrenamiento Personal",
      trim: true,
    },

    status: {
      type: String,
      enum: [
        "waiting",
        "notified",
        "claimed",
        "expired",
        "removed",
        "closed",
      ],
      default: "waiting",
      index: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    priorityOrder: {
      type: Number,
      default: 0,
      index: true,
    },

    notifyToken: {
      type: String,
      default: null,
      index: true,
    },

    tokenExpiresAt: {
      type: Date,
      default: null,
    },

    notifiedAt: {
      type: Date,
      default: null,
    },

    claimedAt: {
      type: Date,
      default: null,
    },

    claimedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    assignedAppointmentId: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },

    closedAt: {
      type: Date,
      default: null,
    },

    closeReason: {
      type: String,
      enum: [
        "",
        "MIN_ADVANCE_REACHED",
        "SLOT_FILLED",
        "MANUAL_CLOSE",
        "USER_CANCELLED",
        "SYSTEM_CLEANUP",
      ],
      default: "",
      trim: true,
    },

    removedAt: {
      type: Date,
      default: null,
    },

    removedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdByUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdByRole: {
      type: String,
      enum: ["client", "guest", "staff", "profesor", "admin", ""],
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

WaitlistEntrySchema.index({
  date: 1,
  time: 1,
  service: 1,
  status: 1,
  priorityOrder: 1,
  createdAt: 1,
});

WaitlistEntrySchema.index(
  { user: 1, date: 1, time: 1, service: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["waiting", "notified"] },
    },
  }
);

WaitlistEntrySchema.index({ status: 1, closedAt: 1, createdAt: 1 });
WaitlistEntrySchema.index({ status: 1, claimedAt: 1 });
WaitlistEntrySchema.index({ assignedAppointmentId: 1 });

const WaitlistEntry =
  mongoose.models.WaitlistEntry ||
  mongoose.model("WaitlistEntry", WaitlistEntrySchema);

export default WaitlistEntry;