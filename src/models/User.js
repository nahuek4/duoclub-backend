// backend/src/models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, default: "" },
    dni: { type: String, default: "" },
    age: { type: Number, default: null },
    weight: { type: Number, default: null },
    notes: { type: String, default: "" },

    credits: { type: Number, default: 0 },

    // ✅ permisos
    role: { type: String, default: "client" }, // "admin" | "client"

    // ✅ plan comercial (independiente del role)
    plan: {
      type: String,
      enum: ["basic", "plus"],
      default: "basic",
    },


    password: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },

    aptoPath: { type: String, default: "" },
    aptoStatus: { type: String, default: "" }, // "uploaded" | "approved" | "rejected"

    // 🔹 Foto del paciente (avatar)
    photoPath: { type: String, default: "" },

    history: [
      {
        action: { type: String, default: "" },
        date: { type: String, default: "" },
        time: { type: String, default: "" },
        service: { type: String, default: "" },
        createdAt: { type: Date, default: Date.now },
      },
    ],


    // =========================
    // ✅ Registro + Verificación + Aprobación Admin
    // =========================
    emailVerified: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    emailVerificationToken: { type: String, default: "" },
    emailVerificationExpires: { type: Date, default: null },

    // 🔹 Datos del formulario inicial
    initialForm: {
      birthDate: { type: String, default: "" }, // "YYYY-MM-DD"
      dni: { type: String, default: "" },
      phone: { type: String, default: "" },
      emergencyContactName: { type: String, default: "" },
      emergencyContactPhone: { type: String, default: "" },

      injuries: { type: String, default: "" },
      surgeries: { type: String, default: "" },
      medications: { type: String, default: "" },
      allergies: { type: String, default: "" },
      diseases: { type: String, default: "" },
      cardiacHistory: { type: String, default: "" },

      sportBackground: { type: String, default: "" },
      trainingFrequency: { type: String, default: "" },
      goals: { type: String, default: "" },

      observations: { type: String, default: "" },
    },

    // 🔹 Historia clínica interna (solo equipo)
    clinicalNotes: [
      {
        date: { type: Date, default: Date.now },
        author: { type: String, default: "" },
        text: { type: String, required: true },
      },
    ],
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model("User", userSchema);
export default User;
