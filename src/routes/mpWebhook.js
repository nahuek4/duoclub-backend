// backend/src/routes/mpWebhook.js
import express from "express";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { sendAdminNewOrderEmail } from "../mail.js";

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

/* =======================
   Helpers membresía / créditos
======================= */
function isPlusActive(user) {
  const m = user?.membership || {};
  if (m.tier !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

function ensureBasicIfExpired(user) {
  const now = new Date();
  user.membership = user.membership || {};

  const expired =
    user.membership.tier === "plus" &&
    user.membership.activeUntil &&
    new Date(user.membership.activeUntil) <= now;

  if (expired) {
    user.membership.tier = "basic";
    user.membership.activeUntil = null;
    user.membership.cancelHours = 24;
    user.membership.cancelsLeft = 1;
    user.membership.creditsExpireDays = 30;
  }

  if (!user.membership.tier) {
    user.membership.tier = "basic";
    user.membership.activeUntil = null;
    user.membership.cancelHours = 24;
    user.membership.cancelsLeft = 1;
    user.membership.creditsExpireDays = 30;
  }
}

function activatePlus(user) {
  const now = new Date();
  const until = new Date(now);
  until.setDate(until.getDate() + 30);

  user.membership = user.membership || {};
  user.membership.tier = "plus";
  user.membership.activeUntil = until;
  user.membership.cancelHours = 12;
  user.membership.cancelsLeft = 2;
  user.membership.creditsExpireDays = 40;
}

function recalcCreditsCache(user) {
  const now = new Date();
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  user.credits = lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Number(lot.remaining || 0);
  }, 0);
}

function addCreditLot(user, { amount, source, orderId, serviceKey }) {
  const now = new Date();
  ensureBasicIfExpired(user);

  const expireDays = isPlusActive(user) ? 40 : 30;
  const exp = new Date(now);
  exp.setDate(exp.getDate() + expireDays);

  user.creditLots = user.creditLots || [];
  user.creditLots.push({
    serviceKey: String(serviceKey || "EP").toUpperCase().trim(),
    amount: Number(amount || 0),
    remaining: Number(amount || 0),
    expiresAt: exp,
    source: source || "",
    orderId: orderId || null,
    createdAt: now,
  });

  recalcCreditsCache(user);
}

/* =======================
   Aplicar orden (idempotente)
======================= */
async function applyOrderIfNeeded(order) {
  if (!order) return { ok: false, error: "Orden inválida" };
  if (order.applied) return { ok: true, message: "Ya aplicada" };

  const user = await User.findById(order.user);
  if (!user) return { ok: false, error: "Usuario no encontrado" };

  const hasItems = Array.isArray(order.items) && order.items.length > 0;

  // 1) primero activar plus si corresponde (para que los lotes expiren en 40)
  if (hasItems) {
    const hasPlus = order.items.some((it) => String(it.kind).toUpperCase() === "MEMBERSHIP");
    if (hasPlus) activatePlus(user);
    else ensureBasicIfExpired(user);
  } else {
    // legacy
    if (order.plusIncluded) activatePlus(user);
    else ensureBasicIfExpired(user);
  }

  // 2) acreditar créditos
  if (hasItems) {
    for (const it of order.items) {
      if (String(it.kind).toUpperCase() !== "CREDITS") continue;
      const qty = Math.max(1, Number(it.qty) || 1);
      const creditsPer = Math.max(0, Number(it.credits) || 0);
      const amount = creditsPer * qty;

      if (amount > 0) {
        addCreditLot(user, {
          amount,
          source: "mp",
          orderId: order._id,
          serviceKey: it.serviceKey || "EP",
        });
      }
    }
  } else {
    const amount = Math.max(0, Number(order.credits) || 0);
    if (amount > 0) {
      addCreditLot(user, {
        amount,
        source: "mp-legacy",
        orderId: order._id,
        serviceKey: order.serviceKey || "EP",
      });
    } else {
      recalcCreditsCache(user);
    }
  }

  user.history = user.history || [];
  user.history.push({
    action: "order_applied_mp",
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toTimeString().slice(0, 5),
    service: "MercadoPago",
    createdAt: new Date(),
  });

  await user.save();

  order.applied = true;
  order.creditsApplied = true; // compat legacy
  await order.save();

  return { ok: true };
}

/* =======================
   ✅ Notificar admin (idempotente)
======================= */
async function notifyAdminIfNeeded(order) {
  if (!order) return;
  if (order.adminNotifiedAt) return;

  try {
    const u = await User.findById(order.user).lean().catch(() => null);
    await sendAdminNewOrderEmail(order, u);
    order.adminNotifiedAt = new Date();
    await order.save();
  } catch (e) {
    console.warn("MP webhook: no se pudo enviar mail admin:", e?.message || e);
    // no marcamos adminNotifiedAt si falló el mail
  }
}

/**
 * POST /payments/mercadopago/webhook
 * idempotente
 */
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

    // Guardar datos del pago
    order.mpPaymentId = String(payment.id || "");
    order.mpMerchantOrderId = String(payment.order?.id || payment.merchant_order_id || "");

    const paidAmount = Number(payment.transaction_amount || 0);
    const expected = Number(order.totalFinal ?? order.total ?? order.price ?? 0);

    // tolerancia mínima por redondeo (si querés, dejala en 0)
    const EPS = 0;

    if (Math.abs(paidAmount - expected) > EPS) {
      order.notes = `Monto no coincide. Paid=${paidAmount} Order=${expected}`;
      await order.save();
      return res.status(200).json({ ok: true });
    }

    if (status !== "approved") {
      order.notes = `MP status: ${status}`;
      await order.save();
      return res.status(200).json({ ok: true });
    }

    // ✅ Pago aprobado
    if (String(order.status || "") !== "paid") {
      order.status = "paid";
      order.paidAt = new Date();
    }

    // ✅ aplicar orden (plus + créditos) de forma idempotente
    const applied = await applyOrderIfNeeded(order);
    if (!applied.ok) {
      order.notes = applied.error || "No se pudo aplicar orden";
      await order.save();
      return res.status(200).json({ ok: true });
    }

    // ✅ Mail al admin SOLO cuando está approved (y solo 1 vez)
    await notifyAdminIfNeeded(order);

    await order.save();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("MP webhook error:", err);
    // MP requiere 200 para no reintentar infinito
    return res.status(200).json({ ok: true });
  }
});

export default router;
