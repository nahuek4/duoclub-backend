// backend/src/routes/mpWebhook.js
import express from "express";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { startOrExtendMembership } from "../utils/membership.js";

const router = express.Router();

function extractPaymentId(req) {
  const q = req.query || {};
  return q["data.id"] || q["data[id]"] || q["id"] || q["payment_id"] || "";
}

async function fetchMpPayment(paymentId) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("MP_ACCESS_TOKEN no configurado.");

  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.message || "Error consultando payment en MercadoPago");
  return data;
}

router.post("/mercadopago/webhook", async (req, res) => {
  try {
    const paymentId = extractPaymentId(req);
    if (!paymentId) return res.status(200).json({ ok: true });

    const payment = await fetchMpPayment(paymentId);

    const status = String(payment.status || "");
    const externalRef = String(payment.external_reference || "");
    if (!externalRef) return res.status(200).json({ ok: true });

    const order = await Order.findById(externalRef);
    if (!order) return res.status(200).json({ ok: true });

    // Guardar data
    order.mpPaymentId = String(payment.id || "");
    order.mpMerchantOrderId = String(payment.order?.id || "");

    const paidAmount = Number(payment.transaction_amount || 0);

    if (paidAmount !== Number(order.price)) {
      order.notes = `Monto no coincide. Paid=${paidAmount} Order=${order.price}`;
      await order.save();
      return res.status(200).json({ ok: true });
    }

    if (status !== "approved") {
      order.notes = `MP status: ${status}`;
      await order.save();
      return res.status(200).json({ ok: true });
    }

    // ✅ Pago aprobado
    order.status = "paid";

    const user = await User.findById(order.user);
    if (!user) {
      await order.save();
      return res.status(200).json({ ok: true });
    }

    if (order.kind === "CREDITS") {
      if (!order.creditsApplied) {
        user.credits = (user.credits || 0) + Number(order.credits || 0);

        user.history = user.history || [];
        user.history.push({
          action: "compra_creditos_mp",
          date: new Date().toISOString().slice(0, 10),
          time: new Date().toTimeString().slice(0, 5),
          service: `Compra ${order.serviceKey}`,
          createdAt: new Date(),
        });

        order.creditsApplied = true;
      }
    }

    if (order.kind === "MEMBERSHIP") {
      if (!order.membershipApplied) {
        startOrExtendMembership(user, {
          tier: order.membershipTier || "PLUS",
          days: order.membershipDays || 30,
        });

        user.history = user.history || [];
        user.history.push({
          action: "compra_membresia_mp",
          date: new Date().toISOString().slice(0, 10),
          time: new Date().toTimeString().slice(0, 5),
          service: `Membresía ${order.membershipTier || "PLUS"}`,
          createdAt: new Date(),
        });

        order.membershipApplied = true;
      }
    }

    await user.save();
    await order.save();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("MP webhook error:", err);
    return res.status(200).json({ ok: true });
  }
});

export default router;
