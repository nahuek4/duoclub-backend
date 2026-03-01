import mongoose from "mongoose";

const personSnapshotSchema = new mongoose.Schema(
  {
    id: { type: String, default: "" },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    role: { type: String, default: "" },
  },
  { _id: false }
);

const activityLogSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true, index: true },
    action: { type: String, required: true, trim: true, index: true },
    entity: { type: String, required: true, trim: true, index: true },
    entityId: { type: String, default: "", trim: true, index: true },
    status: { type: String, default: "success", trim: true, index: true },

    actor: { type: personSnapshotSchema, default: () => ({}) },
    subject: { type: personSnapshotSchema, default: () => ({}) },

    title: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    diff: { type: mongoose.Schema.Types.Mixed, default: {} },
    deletedSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ category: 1, createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });
activityLogSchema.index({ "actor.role": 1, createdAt: -1 });
activityLogSchema.index({ "subject.id": 1, createdAt: -1 });

const ActivityLog = mongoose.model("ActivityLog", activityLogSchema);
export default ActivityLog;
