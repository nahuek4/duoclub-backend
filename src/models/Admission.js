import mongoose from "mongoose";

function cleanString(value) {
  return String(value || "").trim();
}

function cleanEmail(value) {
  return cleanString(value).toLowerCase();
}

const admissionSchema = new mongoose.Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
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

    // idempotencia mails Step2
    step2EmailSent: { type: Boolean, default: false },
    step2EmailSentAt: { type: Date, default: null },

    step1: {
      fullName: { type: String, default: "", trim: true },
      birthDay: { type: String, default: "", trim: true },
      birthMonth: { type: String, default: "", trim: true },
      birthYear: { type: String, default: "", trim: true },
      height: { type: String, default: "", trim: true },
      weight: { type: String, default: "", trim: true },
      city: { type: String, default: "", trim: true },
      cityOther: { type: String, default: "", trim: true },
      phone: { type: String, default: "", trim: true },
      email: { type: String, default: "", trim: true, lowercase: true },

      fitnessLevel: { type: String, default: "", trim: true },
      hasContraindication: { type: String, default: "", trim: true },
      contraindicationDetail: { type: String, default: "", trim: true },
      lastSupervisedTraining: { type: String, default: "", trim: true },
      lastMedicalExam: { type: String, default: "", trim: true },
      hasPain: { type: String, default: "", trim: true },
      hasCondition: { type: String, default: "", trim: true },
      conditionDetail: { type: String, default: "", trim: true },
      hadInjuryLastYear: { type: String, default: "", trim: true },
      injuryDetail: { type: String, default: "", trim: true },

      diabetes: { type: String, default: "", trim: true },
      diabetesType: { type: String, default: "", trim: true },
      bloodPressure: { type: String, default: "", trim: true },

      smokes: { type: String, default: "", trim: true },
      cigarettesPerDay: { type: String, default: "", trim: true },

      heartProblems: { type: String, default: "", trim: true },
      heartDetail: { type: String, default: "", trim: true },

      oncologicTreatment: { type: String, default: "", trim: true },

      orthoProblem: { type: String, default: "", trim: true },
      orthoDetail: { type: String, default: "", trim: true },

      pregnant: { type: String, default: "", trim: true },
      pregnantWeeks: { type: String, default: "", trim: true },

      lastBloodTest: { type: String, default: "", trim: true },
      relevantInfo: { type: String, default: "", trim: true },
    },

    step2: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    ip: { type: String, default: "", trim: true },
    userAgent: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

admissionSchema.pre("validate", function normalizeAdmission(next) {
  this.publicId = cleanString(this.publicId);
  this.ip = cleanString(this.ip);
  this.userAgent = cleanString(this.userAgent);

  if (this.step1 && typeof this.step1 === "object") {
    this.step1.fullName = cleanString(this.step1.fullName);
    this.step1.birthDay = cleanString(this.step1.birthDay);
    this.step1.birthMonth = cleanString(this.step1.birthMonth);
    this.step1.birthYear = cleanString(this.step1.birthYear);
    this.step1.height = cleanString(this.step1.height);
    this.step1.weight = cleanString(this.step1.weight);
    this.step1.city = cleanString(this.step1.city);
    this.step1.cityOther = cleanString(this.step1.cityOther);
    this.step1.phone = cleanString(this.step1.phone);
    this.step1.email = cleanEmail(this.step1.email);

    this.step1.fitnessLevel = cleanString(this.step1.fitnessLevel);
    this.step1.hasContraindication = cleanString(this.step1.hasContraindication);
    this.step1.contraindicationDetail = cleanString(this.step1.contraindicationDetail);
    this.step1.lastSupervisedTraining = cleanString(this.step1.lastSupervisedTraining);
    this.step1.lastMedicalExam = cleanString(this.step1.lastMedicalExam);
    this.step1.hasPain = cleanString(this.step1.hasPain);
    this.step1.hasCondition = cleanString(this.step1.hasCondition);
    this.step1.conditionDetail = cleanString(this.step1.conditionDetail);
    this.step1.hadInjuryLastYear = cleanString(this.step1.hadInjuryLastYear);
    this.step1.injuryDetail = cleanString(this.step1.injuryDetail);

    this.step1.diabetes = cleanString(this.step1.diabetes);
    this.step1.diabetesType = cleanString(this.step1.diabetesType);
    this.step1.bloodPressure = cleanString(this.step1.bloodPressure);

    this.step1.smokes = cleanString(this.step1.smokes);
    this.step1.cigarettesPerDay = cleanString(this.step1.cigarettesPerDay);

    this.step1.heartProblems = cleanString(this.step1.heartProblems);
    this.step1.heartDetail = cleanString(this.step1.heartDetail);

    this.step1.oncologicTreatment = cleanString(this.step1.oncologicTreatment);

    this.step1.orthoProblem = cleanString(this.step1.orthoProblem);
    this.step1.orthoDetail = cleanString(this.step1.orthoDetail);

    this.step1.pregnant = cleanString(this.step1.pregnant);
    this.step1.pregnantWeeks = cleanString(this.step1.pregnantWeeks);

    this.step1.lastBloodTest = cleanString(this.step1.lastBloodTest);
    this.step1.relevantInfo = cleanString(this.step1.relevantInfo);
  }

  if (!this.step2 || typeof this.step2 !== "object") {
    this.step2 = {};
  }

  next();
});

admissionSchema.index({ "step1.email": 1 });
admissionSchema.index({ createdAt: -1 });
admissionSchema.index({ syncedToUser: 1, createdAt: -1 });

const Admission =
  mongoose.models.Admission || mongoose.model("Admission", admissionSchema);

export default Admission;
