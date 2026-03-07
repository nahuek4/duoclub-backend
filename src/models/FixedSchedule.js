// backend/src/models/FixedSchedule.js
import mongoose from "mongoose";

const fixedScheduleItemSchema = new mongoose.Schema(
  {
    // 1 = lunes, 2 = martes ... 5 = viernes
    weekday: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },

    // "HH:mm"
    time: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{2}:\d{2}$/,
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
      validate: {
        validator(arr) {
          if (!Array.isArray(arr) || !arr.length) return false;

          const seen = new Set();
          for (const it of arr) {
            const key = `${it?.weekday}__${it?.time}`;
            if (seen.has(key)) return false;
            seen.add(key);
          }
          return true;
        },
        message:
          "La configuración fija debe tener al menos un ítem y no puede repetir día/horario.",
      },
    },

    months: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      default: 1,
    },

    // rango que cubre la configuración
    startDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    endDate: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

// para listar configuraciones activas de un usuario
fixedScheduleSchema.index({ user: 1, active: 1, createdAt: -1 });

// para filtrar por vigencia
fixedScheduleSchema.index({ active: 1, startDate: 1, endDate: 1 });

const FixedSchedule = mongoose.model("FixedSchedule", fixedScheduleSchema);
export default FixedSchedule;