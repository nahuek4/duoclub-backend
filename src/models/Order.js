// backend/src/models/Order.js
import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    serviceKey: { type: String, required: true, uppercase: true, trim: true }, // EP/RF/AR/RA/NUT
    credits: { type: Number, required: true, min: 1 },
    payMethod: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      enum: ["CASH", "MP"],
    },

    // ✅ Precio final calculado SOLO en backend (por DB pricing)
    price: { type: Number, required: true, min: 0 },
    label: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "expired"],
      default: "pending",
    },

    // Para evitar acreditar 2 veces si entra webhook repetido
    creditsApplied: { type: Boolean, default: false },

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
