import mongoose from "mongoose";

const personSnapshotSchema = new mongoose.Schema(
  {
    id: { type: String, default: "", trim: true },
    name: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true },
    role: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const activityLogSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true, index: true },
    action: { type: String, required: true, trim: true, index: true },
    entity: { type: String, required: true, trim: true, index: true },
    entityId: { type: String, default: "", trim: true, index: true },
    status: {
      type: String,
      default: "success",
      trim: true,
      index: true,
      enum: ["success", "error", "warning", "info"],
    },

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

activityLogSchema.pre("validate", function normalizeActivityLog(next) {
  this.category = String(this.category || "").trim();
  this.action = String(this.action || "").trim();
  this.entity = String(this.entity || "").trim();
  this.entityId = String(this.entityId || "").trim();
  this.title = String(this.title || "").trim();
  this.description = String(this.description || "").trim();

  if (!["success", "error", "warning", "info"].includes(String(this.status || "").trim())) {
    this.status = "success";
  }

  next();
});

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ category: 1, createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });
activityLogSchema.index({ entity: 1, createdAt: -1 });
activityLogSchema.index({ entityId: 1, createdAt: -1 });
activityLogSchema.index({ "actor.role": 1, createdAt: -1 });
activityLogSchema.index({ "subject.id": 1, createdAt: -1 });

const ActivityLog =
  mongoose.models.ActivityLog ||
  mongoose.model("ActivityLog", activityLogSchema);

export default ActivityLog;
