// backend/src/models/Order.js
import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // ✅ Tipo de orden
    kind: {
      type: String,
      enum: ["CREDITS", "MEMBERSHIP"],
      default: "CREDITS",
      uppercase: true,
      trim: true,
    },

    // ===== ORDEN DE CRÉDITOS =====
    serviceKey: { type: String, default: "", uppercase: true, trim: true }, // EP/RF/AR/RA/NUT
    credits: { type: Number, default: 0, min: 0 },

    // ===== ORDEN DE MEMBRESÍA =====
    membershipTier: { type: String, default: "", uppercase: true, trim: true }, // "PLUS"
    membershipDays: { type: Number, default: 0, min: 0 }, // se setea desde MembershipPlan.durationDays

    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
    },

    // ✅ Precio final calculado SOLO en backend (por DB pricing / membership plan)
    price: { type: Number, required: true, min: 0 },
    label: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "expired"],
      default: "pending",
    },

    // Para evitar acreditar 2 veces si entra webhook repetido
    creditsApplied: { type: Boolean, default: false },

    // ✅ Para evitar activar membresía 2 veces
    membershipApplied: { type: Boolean, default: false },

    // MercadoPago data
    mpPreferenceId: { type: String, default: "" },
    mpInitPoint: { type: String, default: "" },
    mpPaymentId: { type: String, default: "" },
    mpMerchantOrderId: { type: String, default: "" },

    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

orderSchema.index({ user: 1, createdAt: -1 });

const Order = mongoose.model("Order", orderSchema);
export default Order;
