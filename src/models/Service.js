// src/models/Service.js
import mongoose from "mongoose";

const serviceSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // "entrenamiento"
    name: { type: String, required: true },              // "Entrenamiento personal"
    color: { type: String, default: "#000000" },
  },
  { timestamps: true }
);

export const Service = mongoose.model("Service", serviceSchema);
