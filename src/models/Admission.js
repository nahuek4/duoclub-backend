import mongoose from "mongoose";

const admissionSchema = new mongoose.Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    syncedToUser: { type: Boolean, default: false },
    syncedAt: { type: Date, default: null },

    step1Completed: { type: Boolean, default: false },
    step2Completed: { type: Boolean, default: false },

    // ✅ idempotencia mails Step2
    step2EmailSent: { type: Boolean, default: false },
    step2EmailSentAt: { type: Date, default: null },

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

    step2: {
      type: Object,
      default: {},
    },

    ip: String,
    userAgent: String,
  },
  { timestamps: true }
);

admissionSchema.index({ "step1.email": 1 });
admissionSchema.index({ createdAt: -1 });

export default mongoose.model("Admission", admissionSchema);
