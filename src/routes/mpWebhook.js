// backend/src/routes/mpWebhook.js
import express from "express";
import Order from "../models/Order.js";
import User from "../models/User.js";

import {
  fireAndForget,
  sendAdminNewOrderEmail,
  sendAdminOrderPaidEmail,
  sendUserOrderPaidEmail,
} from "../mail.js";

const router = express.Router();

/* =======================
   Config / constantes
======================= */
const SERVICE_KEY_TO_NAME = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  PE: "Primera evaluación presencial",
  NUT: "Nutrición",
};

const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "NUT"]);

/* =======================
   Helpers generales
======================= */
function normalizeServiceKey(value, { allowEmpty = false } = {}) {
  const sk = String(value || "").toUpperCase().trim();
  if (!sk) return allowEmpty ? "" : null;
  return ALLOWED_SERVICE_KEYS.has(sk) ? sk : null;
}

function assertServiceKey(value, label = "serviceKey") {
  const sk = normalizeServiceKey(value);
  if (!sk) throw new Error(`${label} inválido.`);
  return sk;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function hm(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function lastDayOfCurrentMonth() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  return new Date(y, m + 1, 0, 23, 59, 59, 999);
}

function extractPaymentId(req) {
  const q = req.query || {};
  const b = req.body || {};

  return (
    q["data.id"] ||
    q["data[id]"] ||
    q["id"] ||
    q["payment_id"] ||
    b?.data?.id ||
    b?.id ||
    b?.payment_id ||
    ""
  );
}

async function fetchMpPayment(paymentId) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("MP_ACCESS_TOKEN no configurado.");

  const resp = await fetch(
    `https://api.mercadopago.com/v1/payments/${paymentId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(
      data?.message || data?.error || "Error consultando payment en MercadoPago"
    );
  }

  return data;
}

/* =======================
   Helpers membresía / créditos
======================= */
const CREDITS_EXPIRE_DAYS = 30;

function isPlusActive(user) {
  const m = user?.membership || {};
  if (String(m.tier || "").toLowerCase() !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

function ensureBasicIfExpired(user) {
  const now = new Date();
  user.membership = user.membership || {};

  const expired =
    String(user.membership.tier || "").toLowerCase() === "plus" &&
    user.membership.activeUntil &&
    new Date(user.membership.activeUntil) <= now;

  if (expired) {
    user.membership.tier = "basic";
    user.membership.activeUntil = null;
    user.membership.cancelHours = 24;
    user.membership.cancelsLeft = 1;
    user.membership.creditsExpireDays = CREDITS_EXPIRE_DAYS;
  }

  if (!user.membership.tier) {
    user.membership.tier = "basic";
    user.membership.activeUntil = null;
    user.membership.cancelHours = 24;
    user.membership.cancelsLeft = 1;
    user.membership.creditsExpireDays = CREDITS_EXPIRE_DAYS;
  }
}

function addPlusMonths(user, months = 1) {
  const now = new Date();
  user.membership = user.membership || {};

  const curUntil = user.membership.activeUntil
    ? new Date(user.membership.activeUntil)
    : null;

  const base = curUntil && curUntil > now ? curUntil : now;

  const until = new Date(base);
  until.setDate(until.getDate() + 30 * Math.max(1, Number(months) || 1));

  user.membership.tier = "plus";
  user.membership.activeUntil = until;
  user.membership.cancelHours = 12;
  user.membership.cancelsLeft = 2;
  user.membership.creditsExpireDays = CREDITS_EXPIRE_DAYS;
}

function activatePlus(user) {
  addPlusMonths(user, 1);
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

function ensureFixedScheduleDebt(user) {
  user.fixedScheduleDebt = user.fixedScheduleDebt || {};

  for (const k of ["EP", "RA", "RF", "KD"]) {
    const n = Number(user.fixedScheduleDebt?.[k] || 0);
    user.fixedScheduleDebt[k] = Number.isFinite(n)
      ? Math.max(0, Math.trunc(n))
      : 0;
  }
}

function settleFixedScheduleDebt(
  user,
  { amount, serviceKey, source = "credits" } = {}
) {
  const sk = assertServiceKey(serviceKey);
  const qty = Math.max(0, Math.trunc(Number(amount || 0)));

  if (!qty) return { settled: 0, remaining: 0 };

  ensureFixedScheduleDebt(user);

  const currentDebt = Math.max(0, Number(user.fixedScheduleDebt?.[sk] || 0));

  if (!currentDebt) return { settled: 0, remaining: qty };

  const settled = Math.min(currentDebt, qty);
  const remaining = qty - settled;

  user.fixedScheduleDebt[sk] = currentDebt - settled;
  user.markModified?.("fixedScheduleDebt");

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "fixed_schedule_debt_settled",
    title: `Deuda de turnos fijos saldada ${sk}`,
    message: `Se usaron ${settled} crédito(s) acreditados para saldar deuda pendiente de turnos fijos.`,
    serviceKey: sk,
    serviceName: SERVICE_KEY_TO_NAME[sk] || sk,
    service: SERVICE_KEY_TO_NAME[sk] || sk,
    qty: settled,
    source,
    createdAt: new Date(),
  });

  return { settled, remaining };
}

function addCreditLot(user, { amount, source, orderId, serviceKey }) {
  const now = new Date();

  ensureBasicIfExpired(user);

  const sk = assertServiceKey(serviceKey);
  const qty = Math.max(0, Number(amount || 0));

  if (!qty) return;

  const debtSettlement = settleFixedScheduleDebt(user, {
    amount: qty,
    serviceKey: sk,
    source,
  });

  const remainingQty = Math.max(0, Number(debtSettlement.remaining || 0));

  if (!remainingQty) {
    recalcCreditsCache(user);
    return;
  }

  // IMPORTANTE:
  // Igual que orders.js: vencen el último día del mes, no a 30 días exactos.
  const exp = lastDayOfCurrentMonth();

  user.creditLots = user.creditLots || [];
  user.creditLots.push({
    serviceKey: sk,
    amount: remainingQty,
    remaining: remainingQty,
    expiresAt: exp,
    source: source || "",
    orderId: orderId || null,
    createdAt: now,
  });

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "credits_added_monthly",
    title: `Créditos acreditados ${sk}`,
    message: `Se acreditaron ${remainingQty} crédito(s), con vencimiento el último día del mes.${
      debtSettlement.settled
        ? ` Antes se saldaron ${debtSettlement.settled} crédito(s) adeudados.`
        : ""
    }`,
    serviceKey: sk,
    serviceName: SERVICE_KEY_TO_NAME[sk] || sk,
    service: SERVICE_KEY_TO_NAME[sk] || sk,
    qty: remainingQty,
    createdAt: now,
  });

  recalcCreditsCache(user);
}

/* =======================
   Aplicar orden completa
   idempotente
======================= */
async function applyOrderIfNeeded(order) {
  if (!order) return { ok: false, error: "Orden inválida." };

  if (order.applied) {
    return { ok: true, message: "Orden ya aplicada." };
  }

  const user = await User.findById(order.user);
  if (!user) return { ok: false, error: "Usuario no encontrado." };

  const hasItems = Array.isArray(order.items) && order.items.length > 0;

  // 1) Membresía primero
  if (hasItems) {
    const membershipItems = order.items.filter(
      (it) => String(it.kind || "").toUpperCase() === "MEMBERSHIP"
    );

    if (membershipItems.length > 0) {
      let monthsToAdd = 0;

      for (const it of membershipItems) {
        const qty = Math.max(1, Number(it.qty) || 1);
        monthsToAdd += qty;
      }

      if (monthsToAdd > 0) {
        addPlusMonths(user, monthsToAdd);
      }
    } else {
      ensureBasicIfExpired(user);
    }
  } else {
    if (order.plusIncluded) activatePlus(user);
    else ensureBasicIfExpired(user);
  }

  // 2) Créditos
  if (!order.creditsApplied) {
    if (hasItems) {
      for (const it of order.items) {
        const kind = String(it.kind || "").toUpperCase();

        if (kind !== "CREDITS") continue;

        const qty = Math.max(1, Number(it.qty) || 1);
        const creditsPer = Math.max(0, Number(it.credits) || 0);
        const totalCredits = creditsPer * qty;

        if (totalCredits > 0) {
          addCreditLot(user, {
            amount: totalCredits,
            source: "mp",
            orderId: order._id,
            serviceKey: assertServiceKey(it.serviceKey),
          });
        }
      }
    } else {
      const totalCredits = Math.max(0, Number(order.credits) || 0);

      if (totalCredits > 0) {
        addCreditLot(user, {
          amount: totalCredits,
          source: "mp-legacy",
          orderId: order._id,
          serviceKey: assertServiceKey(order.serviceKey),
        });
      } else {
        recalcCreditsCache(user);
      }
    }
  }

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "order_applied_mp",
    title: "Se acreditó una orden pagada por Mercado Pago.",
    date: ymd(new Date()),
    time: hm(new Date()),
    service: "MercadoPago",
    createdAt: new Date(),
  });

  await user.save();

  order.applied = true;
  order.creditsApplied = true;
  await order.save();

  return { ok: true };
}

/* =======================
   Mails idempotentes
======================= */
async function notifyAdminNewIfNeeded(order) {
  if (!order) return;
  if (order.adminNotifiedAt) return;

  try {
    const u = order.user
      ? await User.findById(order.user).lean().catch(() => null)
      : null;

    await sendAdminNewOrderEmail(order, u);

    order.adminNotifiedAt = new Date();
    await order.save();
  } catch (e) {
    console.warn(
      "MP webhook: no se pudo enviar mail admin NEW:",
      e?.message || e
    );
  }
}

async function notifyAdminPaidIfNeeded(order) {
  if (!order) return;
  if (order.adminPaidNotifiedAt) return;

  try {
    const u = order.user
      ? await User.findById(order.user).lean().catch(() => null)
      : null;

    await sendAdminOrderPaidEmail(order, u);

    order.adminPaidNotifiedAt = new Date();
    await order.save();
  } catch (e) {
    console.warn(
      "MP webhook: no se pudo enviar mail admin PAID:",
      e?.message || e
    );
  }
}

async function notifyUserPaidIfNeeded(order) {
  if (!order) return;
  if (order.userPaidNotifiedAt) return;

  try {
    const u = order.user
      ? await User.findById(order.user).lean().catch(() => null)
      : null;

    const email = String(u?.email || order?.customerEmail || "").trim();

    if (email) {
      await sendUserOrderPaidEmail(order, u);
      order.userPaidNotifiedAt = new Date();
      await order.save();
    }
  } catch (e) {
    console.warn(
      "MP webhook: no se pudo enviar mail user PAID:",
      e?.message || e
    );
  }
}

/* =======================
   Ruta webhook Mercado Pago

   Montada desde index.js en:
   /payments/mercadopago/webhook
   /api/payments/mercadopago/webhook
======================= */
router.post("/mercadopago/webhook", async (req, res) => {
  try {
    const paymentId = extractPaymentId(req);

    if (!paymentId) {
      return res.status(200).json({ ok: true });
    }

    const payment = await fetchMpPayment(paymentId);

    const status = String(payment.status || "").toLowerCase();
    const externalRef = String(payment.external_reference || "").trim();

    if (!externalRef) {
      return res.status(200).json({ ok: true });
    }

    const order = await Order.findById(externalRef);

    if (!order) {
      return res.status(200).json({ ok: true });
    }

    // Guardar datos del pago de MP
    order.mpPaymentId = String(payment.id || "");
    order.mpMerchantOrderId = String(
      payment.order?.id || payment.merchant_order_id || ""
    );
    order.mpStatus = status;
    order.mpPaidAmount = Number(payment.transaction_amount || 0);

    const expected = Number(order.totalFinal ?? order.total ?? order.price ?? 0);
    const paidAmount = Number(payment.transaction_amount || 0);

    // Tolerancia por redondeos. Si querés permitir $1 o $2, cambiá EPS.
    const EPS = 0;

    if (Math.abs(paidAmount - expected) > EPS) {
      order.notes = [
        order.notes,
        `Monto no coincide. Paid=${paidAmount} Order=${expected}`,
      ]
        .filter(Boolean)
        .join("\n");

      await order.save();
      return res.status(200).json({ ok: true });
    }

    // Si no está aprobado, solo guardamos estado.
    if (status !== "approved") {
      order.notes = [`MP status: ${status}`, order.notes]
        .filter(Boolean)
        .join("\n");

      await order.save();
      return res.status(200).json({ ok: true });
    }

    // Pago aprobado
    const wasPaid = String(order.status || "").toLowerCase() === "paid";

    if (!wasPaid) {
      order.status = "paid";
      order.paidAt = new Date();
    }

    /*
      Links públicos / pagos manuales / órdenes sin usuario:
      - Se marcan como pagados.
      - NO se acreditan créditos automáticamente.
      - Quedan para gestión manual del admin.
    */
    const isManualPublicOrder =
      Boolean(order.publicPaymentLink) ||
      Boolean(order.manualFulfillmentRequired) ||
      !order.user;

    if (isManualPublicOrder) {
      order.applied = false;
      order.creditsApplied = false;

      const manualNote =
        "Pago aprobado por Mercado Pago. Requiere gestión manual. No se acreditaron créditos automáticamente.";

      if (!String(order.notes || "").includes(manualNote)) {
        order.notes = [order.notes, manualNote].filter(Boolean).join("\n");
      }

      await order.save();

      fireAndForget(
        () => notifyAdminNewIfNeeded(order),
        "MAIL_ADMIN_NEW_ORDER_MP_PUBLIC"
      );

      fireAndForget(
        () => notifyAdminPaidIfNeeded(order),
        "MAIL_ADMIN_PAID_ORDER_MP_PUBLIC"
      );

      fireAndForget(
        () => notifyUserPaidIfNeeded(order),
        "MAIL_USER_PAID_ORDER_MP_PUBLIC"
      );

      return res.status(200).json({ ok: true });
    }

    // Orden normal con usuario: aplicar créditos/membresía idempotente
    const applied = await applyOrderIfNeeded(order);

    if (!applied.ok) {
      order.notes = [order.notes, applied.error || "No se pudo aplicar orden"]
        .filter(Boolean)
        .join("\n");

      await order.save();
      return res.status(200).json({ ok: true });
    }

    fireAndForget(
      () => notifyAdminNewIfNeeded(order),
      "MAIL_ADMIN_NEW_ORDER_MP"
    );

    fireAndForget(
      () => notifyAdminPaidIfNeeded(order),
      "MAIL_ADMIN_PAID_ORDER_MP"
    );

    fireAndForget(
      () => notifyUserPaidIfNeeded(order),
      "MAIL_USER_PAID_ORDER_MP"
    );

    await order.save();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("MP webhook error:", err);

    // Devolvemos 200 para evitar reintentos infinitos de Mercado Pago.
    return res.status(200).json({ ok: true });
  }
});

export default router;