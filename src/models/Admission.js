import mongoose from "mongoose";

const admissionSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true },

    step1Completed: { type: Boolean, default: false },
    step2Completed: { type: Boolean, default: false },

    step1: {
      fullName: { type: String, default: "" },
      birthDay: { type: String, default: "" },
      birthMonth: { type: String, default: "" },
      birthYear: { type: String, default: "" },
      height: { type: String, default: "" },
      weight: { type: String, default: "" },
      city: { type: String, default: "" },
      cityOther: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },

      fitnessLevel: { type: String, default: "" },
      hasContraindication: { type: String, default: "" },
      contraindicationDetail: { type: String, default: "" },
      lastSupervisedTraining: { type: String, default: "" },
      lastMedicalExam: { type: String, default: "" },
      hasPain: { type: String, default: "" },
      hasCondition: { type: String, default: "" },
      conditionDetail: { type: String, default: "" },
      hadInjuryLastYear: { type: String, default: "" },
      injuryDetail: { type: String, default: "" },

      diabetes: { type: String, default: "" },
      diabetesType: { type: String, default: "" },
      bloodPressure: { type: String, default: "" },

      smokes: { type: String, default: "" },
      cigarettesPerDay: { type: String, default: "" },

      heartProblems: { type: String, default: "" },
      heartDetail: { type: String, default: "" },

      oncologicTreatment: { type: String, default: "" },

      orthoProblem: { type: String, default: "" },
      orthoDetail: { type: String, default: "" },

      pregnant: { type: String, default: "" },
      pregnantWeeks: { type: String, default: "" },

      relevantInfo: { type: String, default: "" },
    },

    step2: { type: Object, default: {} },

    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

const Admission = mongoose.model("Admission", admissionSchema);
export default Admission;
