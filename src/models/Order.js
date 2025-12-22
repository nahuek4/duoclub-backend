// backend/src/models/Order.js
import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CREDITS", "MEMBERSHIP"],
    },

    // =====================
    // CREDITS
    // =====================
    serviceKey: { type: String, default: "", uppercase: true, trim: true }, // EP/RF/AR/RA/NUT
    credits: { type: Number, default: 0, min: 0 },
    label: { type: String, default: "" },

    // =====================
    // MEMBERSHIP
    // =====================
    membershipTier: { type: String, default: "", lowercase: true, trim: true }, // "plus"
    action: { type: String, default: "BUY", uppercase: true, trim: true }, // BUY | EXTEND

    // =====================
    // qty + precios (server authority)
    // =====================
    qty: { type: Number, default: 1, min: 1 },
    basePrice: { type: Number, default: 0, min: 0 }, // unitario
    price: { type: Number, default: 0, min: 0 }, // subtotal item (basePrice * qty)
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

    // ✅ Checkout nuevo
    items: { type: [orderItemSchema], default: [] },

    // ✅ Totales (server authority)
    totalBase: { type: Number, default: 0, min: 0 }, // suma basePrice * qty
    total: { type: Number, default: 0, min: 0 },     // suma price (subtotales)

    // ✅ Descuento DUO+ (guardado en DB para admin/front)
    discountPercent: { type: Number, default: 0, min: 0 }, // 15
    discountAmount: { type: Number, default: 0, min: 0 },  // monto descuento
    totalFinal: { type: Number, default: 0, min: 0 },      // total - discountAmount

    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "expired", "approved"],
      default: "pending",
    },

    // idempotencia para aplicar una sola vez
    applied: { type: Boolean, default: false },

    // MercadoPago data
    mpPreferenceId: { type: String, default: "" },
    mpInitPoint: { type: String, default: "" },
    mpPaymentId: { type: String, default: "" },
    mpMerchantOrderId: { type: String, default: "" },

    paidAt: { type: Date, default: null },
    notes: { type: String, default: "" },

    // =========================
    // ✅ LEGACY (compatibilidad)
    // =========================
    serviceKey: { type: String, default: "", uppercase: true, trim: true },
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

// Defaults seguros por si alguna orden vieja no manda totalFinal
orderSchema.pre("save", function (next) {
  const t = Number(this.total ?? 0);
  const d = Number(this.discountAmount ?? 0);

  if (!Number.isFinite(this.total) || this.total < 0) this.total = 0;
  if (!Number.isFinite(this.discountAmount) || this.discountAmount < 0) this.discountAmount = 0;
  if (!Number.isFinite(this.discountPercent) || this.discountPercent < 0) this.discountPercent = 0;

  // si no vino totalFinal, lo calculamos
  if (!Number.isFinite(this.totalFinal) || this.totalFinal <= 0) {
    const computed = Math.max(0, Math.round(t - d));
    this.totalFinal = computed;
  }

  next();
});

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

const Order = mongoose.model("Order", orderSchema);
export default Order;
