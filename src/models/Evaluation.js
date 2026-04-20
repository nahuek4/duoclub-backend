import mongoose from "mongoose";

const ALLOWED_SERVICE_KEYS = ["PE", "EP", "RA", "RF", "NUT"];

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function serviceNameFromKey(serviceKey) {
  const sk = String(serviceKey || "").toUpperCase().trim();
  if (sk === "PE") return "Primera evaluación presencial";
  if (sk === "EP") return "Entrenamiento Personal";
  if (sk === "RA") return "Rehabilitación Activa";
  if (sk === "RF") return "Reeducación Funcional";
  if (sk === "NUT") return "Nutrición";
  return "";
}

function normalizeServiceKey(rawServiceKey, rawServiceName = "") {
  const rawKey = String(rawServiceKey || "").toUpperCase().trim();
  if (rawKey === "AR") return "RA";
  if (ALLOWED_SERVICE_KEYS.includes(rawKey)) return rawKey;

  const s = stripAccents(rawServiceName).toLowerCase().trim();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("nutric")) return "NUT";

  return "";
}

const evaluationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Ej: "SFMA_TOP_TIER"
    type: { type: String, required: true, uppercase: true, trim: true },

    // Nombre amigable (UI)
    title: { type: String, default: "", trim: true },

    // Servicio asociado (opcional)
    serviceKey: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
      enum: ["", ...ALLOWED_SERVICE_KEYS],
      index: true,
    },
    serviceName: { type: String, default: "", trim: true },

    // Guarda TODA la data del formulario
    scoring: { type: Object, default: {} },

    notes: { type: String, default: "", trim: true },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

evaluationSchema.pre("validate", function normalizeEvaluationService(next) {
  const normalizedKey = normalizeServiceKey(this.serviceKey, this.serviceName);

  if (this.serviceKey || this.serviceName) {
    this.serviceKey = normalizedKey;
    this.serviceName = normalizedKey ? serviceNameFromKey(normalizedKey) : "";
  }

  next();
});

evaluationSchema.index({ user: 1, createdAt: -1 });
evaluationSchema.index({ type: 1, createdAt: -1 });
evaluationSchema.index({ serviceKey: 1, createdAt: -1 });

const Evaluation =
  mongoose.models.Evaluation || mongoose.model("Evaluation", evaluationSchema);

export default Evaluation;
