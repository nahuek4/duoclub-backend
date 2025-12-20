// backend/src/routes/mpWebhook.js
import express from "express";
import Order from "../models/Order.js";
import User from "../models/User.js";

const router = express.Router();

// MP manda notificaciones: suele venir query: ?type=payment&data.id=123
// A veces: ?topic=payment&id=123
function extractPaymentId(req) {
  const q = req.query || {};
  return (
    q["data.id"] ||
    q["data[id]"] ||
    q["id"] ||
    q["payment_id"] ||
    ""
  );
}

async function fetchMpPayment(paymentId) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("MP_ACCESS_TOKEN no configurado.");

  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.message || "Error consultando payment en MercadoPago";
    throw new Error(msg);
  }
  return data;
}

/**
 * POST /payments/mercadopago/webhook
 * MP reintenta muchas veces => endpoint debe ser idempotente
 */
router.post("/mercadopago/webhook", async (req, res) => {
  try {
    const paymentId = extractPaymentId(req);

    // MP a veces manda otras notificaciones; respondemos 200 para que no reintente infinito
    if (!paymentId) return res.status(200).json({ ok: true });

    const payment = await fetchMpPayment(paymentId);

    const status = String(payment.status || "");
    const externalRef = String(payment.external_reference || "");

    if (!externalRef) {
      return res.status(200).json({ ok: true });
    }

    const order = await Order.findById(externalRef);
    if (!order) {
      return res.status(200).json({ ok: true }); // no existe => no reintentar
    }

    // Guardar datos del pago
    order.mpPaymentId = String(payment.id || "");
    order.mpMerchantOrderId = String(payment.order?.id || "");

    // Validaciones
    const paidAmount = Number(payment.transaction_amount || 0);

    if (paidAmount !== Number(order.price)) {
      order.notes = `Monto no coincide. Paid=${paidAmount} Order=${order.price}`;
      await order.save();
      return res.status(200).json({ ok: true });
    }

    if (status !== "approved") {
      // pending / rejected
      order.notes = `MP status: ${status}`;
      await order.save();
      return res.status(200).json({ ok: true });
    }

    // ✅ Pago aprobado: marcar paid e acreditar créditos (solo 1 vez)
    order.status = "paid";

    if (!order.creditsApplied) {
      const user = await User.findById(order.user);
      if (user) {
        user.credits = (user.credits || 0) + Number(order.credits || 0);

        user.history = user.history || [];
        user.history.push({
          action: "compra_creditos_mp",
          date: new Date().toISOString().slice(0, 10),
          time: new Date().toTimeString().slice(0, 5),
          service: `Compra ${order.serviceKey}`,
          createdAt: new Date(),
        });

        await user.save();
      }

      order.creditsApplied = true;
    }

    await order.save();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("MP webhook error:", err);
    // Respondemos 200 para evitar loops de reintentos agresivos.
    return res.status(200).json({ ok: true });
  }
});

export default router;
