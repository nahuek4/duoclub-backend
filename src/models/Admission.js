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

export default mongoose.model("Admission", admissionSchema);
