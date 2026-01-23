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

    // CREDITS
    serviceKey: { type: String, default: "", uppercase: true, trim: true }, // EP/RF/AR/RA/NUT
    credits: { type: Number, default: 0, min: 0 },
    label: { type: String, default: "" },

    // MEMBERSHIP
    membershipTier: { type: String, default: "", lowercase: true, trim: true }, // plus
    action: {
      type: String,
      default: "BUY",
      uppercase: true,
      trim: true,
      enum: ["BUY", "EXTEND"],
    },

    // qty + precios por item (server authority)
    qty: { type: Number, default: 1, min: 1 },
    basePrice: { type: Number, default: 0, min: 0 }, // precio unitario
    price: { type: Number, default: 0, min: 0 }, // subtotal item
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

    // OJO: antes lo tenías required:true y te explota con órdenes legacy viejas.
    // Lo dejamos con default y lo auto-completamos en pre('validate').
    total: { type: Number, default: 0, min: 0 },

    // ✅ descuento DUO+ (hoy solo aplica a SHOP, si existiera)
    discountPercent: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalFinal: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "expired", "approved"],
      default: "pending",
    },

    applied: { type: Boolean, default: false },

    // ✅ evita mandar mail admin 2 veces (CASH + MP webhook reintentos)
    adminNotifiedAt: { type: Date, default: null },

    // ✅ NUEVO: idempotencia mails "pagado"
    adminPaidNotifiedAt: { type: Date, default: null },
    userPaidNotifiedAt: { type: Date, default: null },

    // MercadoPago data
    mpPreferenceId: { type: String, default: "" },
    mpInitPoint: { type: String, default: "" },
    mpPaymentId: { type: String, default: "" },
    mpMerchantOrderId: { type: String, default: "" },

    // ✅ NUEVO: tracking webhook MP
    mpStatus: { type: String, default: "" },
    mpPaidAmount: { type: Number, default: 0, min: 0 },

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
    price: { type: Number, default: 0, min: 0 }, // legacy total
    label: { type: String, default: "" },
    creditsApplied: { type: Boolean, default: false },
    mpInitPointLegacy: { type: String, default: "" },
  },
  { timestamps: true }
);

/**
 * ✅ Arregla:
 * - órdenes viejas sin total (total required)
 * - asegura totalFinal coherente
 */
orderSchema.pre("validate", function () {
  // total (base) para legacy
  if (this.total == null || Number.isFinite(this.total) === false) {
    this.total = 0;
  }

  // Si es legacy y no tiene total, usar price
  if (
    (this.total === 0 || this.total == null) &&
    this.price > 0 &&
    (!this.items || this.items.length === 0)
  ) {
    this.total = Number(this.price || 0);
  }

  // Si es checkout y total quedó 0 por alguna razón, recalcular desde items
  if (
    (this.total === 0 || this.total == null) &&
    Array.isArray(this.items) &&
    this.items.length > 0
  ) {
    const sum = this.items.reduce((acc, it) => acc + Number(it.price || 0), 0);
    this.total = Math.round(sum);
  }

  // totalFinal
  if (this.totalFinal == null || Number.isFinite(this.totalFinal) === false) {
    this.totalFinal = 0;
  }

  // si totalFinal quedó 0 pero hay total, calcularlo
  if ((this.totalFinal === 0 || this.totalFinal == null) && (this.total || 0) > 0) {
    const disc = Math.max(0, Number(this.discountAmount || 0));
    this.totalFinal = Math.max(0, Math.round(Number(this.total || 0) - disc));
  }

  // normalizar numbers
  this.discountPercent = Math.max(0, Number(this.discountPercent || 0));
  this.discountAmount = Math.max(0, Number(this.discountAmount || 0));
  this.totalBase = Math.max(0, Number(this.totalBase || 0));
  this.total = Math.max(0, Number(this.total || 0));
  this.totalFinal = Math.max(0, Number(this.totalFinal || 0));
});

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

const Order = mongoose.model("Order", orderSchema);
export default Order;
