import mongoose from "mongoose";

const ALLOWED_SERVICE_KEYS = ["PE", "EP", "RA", "RF", "NUT"];
const ALLOWED_SERVICE_KEY_SET = new Set(ALLOWED_SERVICE_KEYS);

function normalizeServiceKey(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw === "AR") return "RA";
  return raw;
}

function isValidServiceKey(value) {
  const key = normalizeServiceKey(value);
  return ALLOWED_SERVICE_KEY_SET.has(key);
}

const orderItemSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CREDITS", "MEMBERSHIP"],
    },

    // CREDITS
    serviceKey: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
      validate: {
        validator(value) {
          const kind = String(this?.kind || "").toUpperCase().trim();
          const normalized = normalizeServiceKey(value);

          if (kind !== "CREDITS") {
            return normalized === "";
          }

          return isValidServiceKey(normalized);
        },
        message: "serviceKey inválido para el item de orden.",
      },
    },
    credits: { type: Number, default: 0, min: 0 },
    label: { type: String, default: "" },

    // MEMBERSHIP
    membershipTier: { type: String, default: "", lowercase: true, trim: true },
    action: {
      type: String,
      default: "BUY",
      uppercase: true,
      trim: true,
      enum: ["BUY", "EXTEND"],
    },

    // qty + precios por item (server authority)
    qty: { type: Number, default: 1, min: 1 },
    basePrice: { type: Number, default: 0, min: 0 },
    price: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
    },

    // ✅ items (checkout)
    items: { type: [orderItemSchema], default: [] },

    // ✅ totales (server authority)
    totalBase: { type: Number, default: 0, min: 0 },

    total: { type: Number, default: 0, min: 0 },

    // ✅ descuento DUO+
    discountPercent: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalFinal: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "expired", "approved"],
      default: "pending",
    },

    applied: { type: Boolean, default: false },

    // idempotencia mails
    adminNotifiedAt: { type: Date, default: null },
    adminPaidNotifiedAt: { type: Date, default: null },
    userPaidNotifiedAt: { type: Date, default: null },

    // MercadoPago data
    mpPreferenceId: { type: String, default: "" },
    mpInitPoint: { type: String, default: "" },
    mpPaymentId: { type: String, default: "" },
    mpMerchantOrderId: { type: String, default: "" },
    mpStatus: { type: String, default: "" },
    mpPaidAmount: { type: Number, default: 0, min: 0 },

    paidAt: { type: Date, default: null },
    notes: { type: String, default: "" },

    // =========================
    // ✅ LEGACY (compatibilidad)
    // =========================
    serviceKey: {
      type: String,
      default: "",
      uppercase: true,
      trim: true,
      validate: {
        validator(value) {
          const normalized = normalizeServiceKey(value);
          return normalized === "" || isValidServiceKey(normalized);
        },
        message: "serviceKey legacy inválido.",
      },
    },
    credits: { type: Number, default: 0, min: 0 },
    basePrice: { type: Number, default: 0, min: 0 },
    plusIncluded: { type: Boolean, default: false },
    plusPrice: { type: Number, default: 0, min: 0 },
    price: { type: Number, default: 0, min: 0 },
    label: { type: String, default: "" },
    creditsApplied: { type: Boolean, default: false },
    mpInitPointLegacy: { type: String, default: "" },
  },
  { timestamps: true }
);

orderSchema.pre("validate", function (next) {
  try {
    // Normalización serviceKey legacy
    this.serviceKey = normalizeServiceKey(this.serviceKey);

    // Normalización items
    if (Array.isArray(this.items)) {
      this.items = this.items.map((it) => {
        const item = typeof it?.toObject === "function" ? it.toObject() : { ...it };
        const kind = String(item?.kind || "").toUpperCase().trim();

        if (kind === "CREDITS") {
          item.serviceKey = normalizeServiceKey(item.serviceKey);
        } else {
          item.serviceKey = "";
        }

        return item;
      });
    }

    // total legacy
    if (this.total == null || Number.isFinite(this.total) === false) {
      this.total = 0;
    }

    if (
      (this.total === 0 || this.total == null) &&
      this.price > 0 &&
      (!this.items || this.items.length === 0)
    ) {
      this.total = Number(this.price || 0);
    }

    if (
      (this.total === 0 || this.total == null) &&
      Array.isArray(this.items) &&
      this.items.length > 0
    ) {
      const sum = this.items.reduce((acc, it) => acc + Number(it?.price || 0), 0);
      this.total = Math.round(sum);
    }

    if (this.totalFinal == null || Number.isFinite(this.totalFinal) === false) {
      this.totalFinal = 0;
    }

    if ((this.totalFinal === 0 || this.totalFinal == null) && (this.total || 0) > 0) {
      const disc = Math.max(0, Number(this.discountAmount || 0));
      this.totalFinal = Math.max(0, Math.round(Number(this.total || 0) - disc));
    }

    this.discountPercent = Math.max(0, Number(this.discountPercent || 0));
    this.discountAmount = Math.max(0, Number(this.discountAmount || 0));
    this.totalBase = Math.max(0, Number(this.totalBase || 0));
    this.total = Math.max(0, Number(this.total || 0));
    this.totalFinal = Math.max(0, Number(this.totalFinal || 0));

    next();
  } catch (err) {
    next(err);
  }
});

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ serviceKey: 1, createdAt: -1 });

const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
export default Order;
