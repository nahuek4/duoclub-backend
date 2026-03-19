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
      enum: ["waiting", "notified", "claimed", "expired", "removed"],
      default: "waiting",
      index: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
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
    removedAt: {
      type: Date,
      default: null,
    },
    removedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

WaitlistEntrySchema.index({ date: 1, time: 1, service: 1, status: 1, createdAt: 1 });
WaitlistEntrySchema.index({ user: 1, date: 1, time: 1, service: 1, status: 1 });

const WaitlistEntry =
  mongoose.models.WaitlistEntry ||
  mongoose.model("WaitlistEntry", WaitlistEntrySchema);

export default WaitlistEntry;
