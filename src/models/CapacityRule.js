import mongoose from "mongoose";

const capacityRuleSchema = new mongoose.Schema(
  {
    targetType: {
      type: String,
      enum: ["zone", "service"],
      required: true,
      index: true,
    },

    zone: {
      type: String,
      enum: ["TRAINING", "PERFORMANCE"],
      required: true,
      index: true,
    },

    serviceKey: {
      type: String,
      enum: ["", "EP", "RA", "RF", "SYN"],
      default: "",
      trim: true,
      uppercase: true,
      index: true,
    },

    scope: {
      type: String,
      enum: ["default", "month", "date", "slot"],
      required: true,
      default: "default",
      index: true,
    },

    // Se completan solamente según el alcance elegido.
    monthKey: {
      type: String,
      default: "",
      trim: true,
      match: /^$|^\d{4}-\d{2}$/,
      index: true,
    },

    date: {
      type: String,
      default: "",
      trim: true,
      match: /^$|^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },

    time: {
      type: String,
      default: "",
      trim: true,
      match: /^$|^\d{2}:\d{2}$/,
      index: true,
    },

    // 0 es válido: permite cerrar cupos sin crear un bloqueo de agenda.
    limit: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

capacityRuleSchema.pre("validate", function normalizeCapacityRule() {
  this.targetType = String(this.targetType || "").toLowerCase().trim();
  this.zone = String(this.zone || "").toUpperCase().trim();
  this.serviceKey = String(this.serviceKey || "").toUpperCase().trim();
  this.scope = String(this.scope || "default").toLowerCase().trim();

  if (this.targetType === "zone") {
    this.serviceKey = "";
  }

  if (this.scope === "default") {
    this.monthKey = "";
    this.date = "";
    this.time = "";
  } else if (this.scope === "month") {
    this.date = "";
    this.time = "";
  } else if (this.scope === "date") {
    this.monthKey = "";
    this.time = "";
  } else if (this.scope === "slot") {
    this.monthKey = "";
  }
});

capacityRuleSchema.index(
  {
    zone: 1,
    serviceKey: 1,
    targetType: 1,
    scope: 1,
    monthKey: 1,
    date: 1,
    time: 1,
  },
  { unique: true }
);

capacityRuleSchema.index({ active: 1, zone: 1, scope: 1, date: 1, time: 1 });

const CapacityRule =
  mongoose.models.CapacityRule ||
  mongoose.model("CapacityRule", capacityRuleSchema);

export default CapacityRule;
