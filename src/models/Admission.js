// backend/src/models/Admission.js
import mongoose from "mongoose";

const admissionSchema = new mongoose.Schema(
  {
    // ID público (para compartir / debug)
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // ✅ Vinculación opcional a User
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // ✅ tracking sync
    syncedToUser: { type: Boolean, default: false },
    syncedAt: { type: Date, default: null },

    // Estado de pasos
    step1Completed: { type: Boolean, default: false },
    step2Completed: { type: Boolean, default: false },

    // ===============================
    // STEP 1 (Formulario inicial)
    // ===============================
    step1: {
      fullName: String,
      birthDay: String,
      birthMonth: String,
      birthYear: String,
      height: String,
      weight: String,
      city: String,
      cityOther: String,
      phone: String,
      email: String,

      fitnessLevel: String,
      hasContraindication: String,
      contraindicationDetail: String,
      lastSupervisedTraining: String,
      lastMedicalExam: String,
      hasPain: String,
      hasCondition: String,
      conditionDetail: String,
      hadInjuryLastYear: String,
      injuryDetail: String,

      diabetes: String,
      diabetesType: String,
      bloodPressure: String,

      smokes: String,
      cigarettesPerDay: String,

      heartProblems: String,
      heartDetail: String,

      oncologicTreatment: String,

      orthoProblem: String,
      orthoDetail: String,

      pregnant: String,
      pregnantWeeks: String,

      lastBloodTest: String,
      relevantInfo: String,
    },

    // ===============================
    // STEP 2 (rehab / deporte / plan)
    // ===============================
    step2: {
      type: Object,
      default: {},
    },

    // Metadata útil
    ip: String,
    userAgent: String,
  },
  {
    timestamps: true,
  }
);

// ✅ indices útiles
admissionSchema.index({ "step1.email": 1 });
admissionSchema.index({ createdAt: -1 });

export default mongoose.model("Admission", admissionSchema);
