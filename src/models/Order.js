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

    // qty + precios por item (server authority)
    qty: { type: Number, default: 1, min: 1 },
    basePrice: { type: Number, default: 0, min: 0 }, // precio unitario
    price: { type: Number, default: 0, min: 0 }, // total item = basePrice * qty (o final unitario si querés)
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

    // ✅ NUEVO: items (orden madre)
    items: { type: [orderItemSchema], default: [] },

    // ✅ totales (server authority)
    totalBase: { type: Number, default: 0, min: 0 }, // suma de basePrice*qty
    total: { type: Number, required: true, min: 0 }, // total final a cobrar

    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "expired"],
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
    // (órdenes viejas en tu DB)
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


orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

const Order = mongoose.model("Order", orderSchema);
export default Order;
