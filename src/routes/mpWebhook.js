// backend/src/routes/mpWebhook.js
import express from "express";
import mongoose from "mongoose";

import Order from "../models/Order.js";
import User from "../models/User.js";

import {
  fireAndForget,
  sendAdminNewOrderEmail,
  sendAdminOrderPaidEmail,
  sendUserOrderPaidEmail,
} from "../mail.js";

const router = express.Router();

/* =========================================================
   Mercado Pago Webhook PRO
   - Filtra notificaciones que no sean de payment.
   - Consulta siempre el pago real en MP.
   - Usa external_reference = Order._id.
   - Aplica créditos/membresía solo con status approved.
   - No acredita links públicos/manuales.
   - Idempotente: no duplica créditos si MP reintenta.
   - Transaccional: evita carreras entre webhooks/jobs.
   - Mails sin save() paralelo sobre el mismo documento.
========================================================= */

/* =======================
   Config / constantes
======================= */
const CREDITS_EXPIRE_DAYS = 30;
const APPLY_MAX_RETRIES = Number(process.env.MP_APPLY_MAX_RETRIES || 4);

const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "NUT"]);

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  NUT: "Nutrición",
};

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
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
}

function appendNote(current, note) {
  const cur = String(current || "").trim();
  const n = String(note || "").trim();
  if (!n) return cur;
  if (cur.includes(n)) return cur;
  return [cur, n].filter(Boolean).join("\n");
}

function isVersionOrWriteConflictError(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || "");

  return (
    name === "VersionError" ||
    name === "MongoServerError" ||
    msg.includes("VersionError") ||
    msg.includes("WriteConflict") ||
    msg.includes("No matching document found") ||
    Boolean(err?.hasErrorLabel?.("TransientTransactionError")) ||
    Boolean(err?.hasErrorLabel?.("UnknownTransactionCommitResult"))
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectMpNotification(req) {
  const q = req.query || {};
  const b = req.body || {};

  const topic = String(q.topic || q.type || b.type || "").toLowerCase().trim();
  const action = String(q.action || b.action || "").toLowerCase().trim();
  const liveMode = b.live_mode ?? q.live_mode ?? null;

  const paymentId = String(
    q["data.id"] ||
      q["data[id]"] ||
      q.payment_id ||
      b?.data?.id ||
      b?.id ||
      b?.payment_id ||
      ""
  ).trim();

  const rawId = String(q.id || b.id || "").trim();
  const candidateId = paymentId || rawId;

  const explicitlyPayment =
    topic === "payment" ||
    topic === "payments" ||
    action.startsWith("payment.") ||
    action.includes("payment");

  const explicitlyNotPayment =
    topic &&
    !["payment", "payments"].includes(topic) &&
    !action.startsWith("payment.") &&
    !action.includes("payment");

  return {
    topic,
    action,
    liveMode,
    paymentId: candidateId,
    explicitlyPayment,
    explicitlyNotPayment,
  };
}

async function fetchMpPayment(paymentId) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("MP_ACCESS_TOKEN no configurado.");

  const resp = await fetch(
    `https://api.mercadopago.com/v1/payments/${encodeURIComponent(String(paymentId))}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const err = new Error(data?.message || data?.error || "Error consultando payment en MercadoPago");
    err.status = resp.status;
    err.mpResponse = data;
    throw err;
  }

  return data;
}

function buildPaymentInfo(payment) {
  return {
    paymentId: String(payment?.id || ""),
    merchantOrderId: String(payment?.order?.id || payment?.merchant_order_id || ""),
    status: String(payment?.status || "").toLowerCase().trim(),
    statusDetail: String(payment?.status_detail || "").trim(),
    externalRef: String(payment?.external_reference || "").trim(),
    paidAmount: Number(payment?.transaction_amount || 0),
    paymentMethodId: String(payment?.payment_method_id || ""),
    paymentTypeId: String(payment?.payment_type_id || ""),
    liveMode: payment?.live_mode ?? null,
  };
}

/* =======================
   Helpers membresía / créditos
======================= */
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

  const curUntil = user.membership.activeUntil ? new Date(user.membership.activeUntil) : null;
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

function normalizeLotServiceKey(lot) {
  return normalizeServiceKey(lot?.serviceKey, { allowEmpty: true }) || "";
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
    user.fixedScheduleDebt[k] = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
}

function settleFixedScheduleDebt(user, { amount, serviceKey, source = "credits" } = {}) {
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

  // Igual que orders.js: vencimiento operativo al último día del mes.
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

function applyMembershipFromOrder(user, order) {
  const hasItems = Array.isArray(order.items) && order.items.length > 0;

  if (hasItems) {
    const membershipItems = order.items.filter(
      (it) => String(it.kind || "").toUpperCase() === "MEMBERSHIP"
    );

    if (membershipItems.length > 0) {
      let monthsToAdd = 0;

      for (const it of membershipItems) {
        monthsToAdd += Math.max(1, Number(it.qty) || 1);
      }

      if (monthsToAdd > 0) addPlusMonths(user, monthsToAdd);
      return;
    }

    ensureBasicIfExpired(user);
    return;
  }

  if (order.plusIncluded) activatePlus(user);
  else ensureBasicIfExpired(user);
}

function applyCreditsFromOrder(user, order) {
  if (order.creditsApplied) return;

  const hasItems = Array.isArray(order.items) && order.items.length > 0;

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
    return;
  }

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

function isManualPublicOrder(order) {
  return Boolean(order.publicPaymentLink) || Boolean(order.manualFulfillmentRequired) || !order.user;
}

function setOrderPaymentFields(order, paymentInfo) {
  order.mpPaymentId = String(paymentInfo.paymentId || "");
  order.mpMerchantOrderId = String(paymentInfo.merchantOrderId || "");
  order.mpStatus = String(paymentInfo.status || "");
  order.mpPaidAmount = Number(paymentInfo.paidAmount || 0);
}

function getExpectedAmount(order) {
  return Number(order.totalFinal ?? order.total ?? order.price ?? 0);
}

/* =======================
   Aplicación transaccional
======================= */
async function applyApprovedOrderOnce({ orderId, paymentInfo }) {
  const session = await mongoose.startSession();

  try {
    let result = { ok: true, alreadyApplied: false, manual: false };

    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        result = { ok: false, error: "ORDER_NOT_FOUND" };
        return;
      }

      setOrderPaymentFields(order, paymentInfo);

      if (String(order.status || "").toLowerCase() !== "paid") {
        order.status = "paid";
        order.paidAt = new Date();
      }

      if (isManualPublicOrder(order)) {
        order.applied = false;
        order.creditsApplied = false;
        order.notes = appendNote(
          order.notes,
          "Pago aprobado por Mercado Pago. Requiere gestión manual. No se acreditaron créditos automáticamente."
        );
        await order.save({ session });
        result = { ok: true, manual: true, orderId: String(order._id) };
        return;
      }

      if (order.applied) {
        await order.save({ session });
        result = { ok: true, alreadyApplied: true, orderId: String(order._id) };
        return;
      }

      const user = await User.findById(order.user).session(session);
      if (!user) {
        order.notes = appendNote(order.notes, "Usuario no encontrado al aplicar pago MP.");
        await order.save({ session });
        result = { ok: false, error: "USER_NOT_FOUND", orderId: String(order._id) };
        return;
      }

      applyMembershipFromOrder(user, order);
      applyCreditsFromOrder(user, order);

      user.history = Array.isArray(user.history) ? user.history : [];
      user.history.push({
        action: "order_applied_mp",
        title: "Se acreditó una orden pagada por Mercado Pago.",
        date: ymd(new Date()),
        time: hm(new Date()),
        service: "MercadoPago",
        mpPaymentId: paymentInfo.paymentId || "",
        orderId: order._id,
        createdAt: new Date(),
      });

      await user.save({ session });

      order.applied = true;
      order.creditsApplied = true;
      await order.save({ session });

      result = { ok: true, applied: true, orderId: String(order._id), userId: String(user._id) };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

async function applyApprovedOrderWithRetry({ orderId, paymentInfo }) {
  let lastError = null;

  for (let attempt = 1; attempt <= APPLY_MAX_RETRIES; attempt += 1) {
    try {
      return await applyApprovedOrderOnce({ orderId, paymentInfo });
    } catch (err) {
      lastError = err;

      if (!isVersionOrWriteConflictError(err) || attempt >= APPLY_MAX_RETRIES) {
        throw err;
      }

      console.warn("[MP WEBHOOK] retry apply order", {
        orderId: String(orderId),
        attempt,
        max: APPLY_MAX_RETRIES,
        error: err?.message || String(err),
      });

      await wait(120 * attempt);
    }
  }

  throw lastError;
}

/* =======================
   Mails idempotentes sin save() paralelo
======================= */
async function getOrderAndUserLean(orderId) {
  const order = await Order.findById(orderId).lean().catch(() => null);
  if (!order) return { order: null, user: null };

  const user = order.user ? await User.findById(order.user).lean().catch(() => null) : null;

  const fallbackUser = user || {
    _id: order.user || null,
    name: order.customerName || "Cliente",
    fullName: order.customerName || "Cliente",
    email: order.customerEmail || "",
    phone: order.customerPhone || "",
  };

  return { order, user: fallbackUser };
}

async function notifyAdminNewIfNeeded(orderId) {
  const { order, user } = await getOrderAndUserLean(orderId);
  if (!order || order.adminNotifiedAt) return;

  try {
    await sendAdminNewOrderEmail(order, user);
    await Order.updateOne(
      { _id: orderId, adminNotifiedAt: null },
      { $set: { adminNotifiedAt: new Date() } }
    );
  } catch (e) {
    console.warn("MP webhook: no se pudo enviar mail admin NEW:", e?.message || e);
  }
}

async function notifyAdminPaidIfNeeded(orderId) {
  const { order, user } = await getOrderAndUserLean(orderId);
  if (!order || order.adminPaidNotifiedAt) return;

  try {
    await sendAdminOrderPaidEmail(order, user);
    await Order.updateOne(
      { _id: orderId, adminPaidNotifiedAt: null },
      { $set: { adminPaidNotifiedAt: new Date() } }
    );
  } catch (e) {
    console.warn("MP webhook: no se pudo enviar mail admin PAID:", e?.message || e);
  }
}

async function notifyUserPaidIfNeeded(orderId) {
  const { order, user } = await getOrderAndUserLean(orderId);
  if (!order || order.userPaidNotifiedAt) return;

  const email = String(user?.email || order?.customerEmail || "").trim();
  if (!email) return;

  try {
    await sendUserOrderPaidEmail(order, user);
    await Order.updateOne(
      { _id: orderId, userPaidNotifiedAt: null },
      { $set: { userPaidNotifiedAt: new Date() } }
    );
  } catch (e) {
    console.warn("MP webhook: no se pudo enviar mail user PAID:", e?.message || e);
  }
}

function sendPaidNotifications(orderId, label = "MP") {
  fireAndForget(() => notifyAdminNewIfNeeded(orderId), `MAIL_ADMIN_NEW_ORDER_${label}`);
  fireAndForget(() => notifyAdminPaidIfNeeded(orderId), `MAIL_ADMIN_PAID_ORDER_${label}`);
  fireAndForget(() => notifyUserPaidIfNeeded(orderId), `MAIL_USER_PAID_ORDER_${label}`);
}

/* =======================
   Guardar estado no aprobado
======================= */
async function saveNonApprovedPaymentState({ orderId, paymentInfo }) {
  const order = await Order.findById(orderId);
  if (!order) return { ok: false, error: "ORDER_NOT_FOUND" };

  setOrderPaymentFields(order, paymentInfo);

  // No cambiamos status interno a paid si MP no aprobó.
  // Para rejected/cancelled queda como pending para auditoría/admin.
  order.notes = appendNote(
    order.notes,
    `MP status: ${paymentInfo.status || "unknown"}${
      paymentInfo.statusDetail ? ` (${paymentInfo.statusDetail})` : ""
    }`
  );

  await order.save();
  return { ok: true };
}

/* =======================
   Ruta webhook Mercado Pago

   En tu index.js queda montada como:
   /payments/mercadopago/webhook
   /api/payments/mercadopago/webhook
======================= */
router.post("/mercadopago/webhook", async (req, res) => {
  try {
    const notification = detectMpNotification(req);

    if (notification.explicitlyNotPayment) {
      console.log("[MP WEBHOOK] ignored non-payment notification", {
        topic: notification.topic,
        action: notification.action,
      });
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!notification.paymentId) {
      console.log("[MP WEBHOOK] ignored without payment id", {
        topic: notification.topic,
        action: notification.action,
        body: req.body || {},
        query: req.query || {},
      });
      return res.status(200).json({ ok: true, ignored: true });
    }

    let payment;
    try {
      payment = await fetchMpPayment(notification.paymentId);
    } catch (err) {
      // Payment not found suele ser notificación de otro recurso, token TEST/PROD cruzado,
      // o reintento viejo. Respondemos 200 para no generar loop infinito.
      console.warn("[MP WEBHOOK] fetch payment failed", {
        paymentId: notification.paymentId,
        topic: notification.topic,
        action: notification.action,
        status: err?.status || null,
        message: err?.message || String(err),
        mpResponse: err?.mpResponse || null,
      });
      return res.status(200).json({ ok: true, ignored: true });
    }

    const paymentInfo = buildPaymentInfo(payment);

    if (!paymentInfo.externalRef) {
      console.log("[MP WEBHOOK] payment without external_reference", {
        paymentId: paymentInfo.paymentId,
        status: paymentInfo.status,
      });
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!mongoose.Types.ObjectId.isValid(paymentInfo.externalRef)) {
      console.warn("[MP WEBHOOK] invalid external_reference", {
        externalRef: paymentInfo.externalRef,
        paymentId: paymentInfo.paymentId,
      });
      return res.status(200).json({ ok: true, ignored: true });
    }

    const order = await Order.findById(paymentInfo.externalRef).lean();
    if (!order) {
      console.warn("[MP WEBHOOK] order not found", {
        externalRef: paymentInfo.externalRef,
        paymentId: paymentInfo.paymentId,
      });
      return res.status(200).json({ ok: true, ignored: true });
    }

    const expected = getExpectedAmount(order);
    const paidAmount = Number(paymentInfo.paidAmount || 0);

    // Tolerancia por redondeo. Si alguna vez necesitás $1/$2 de margen, subí EPS.
    const EPS = Number(process.env.MP_AMOUNT_EPS || 0);

    if (Math.abs(paidAmount - expected) > EPS) {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            mpPaymentId: paymentInfo.paymentId,
            mpMerchantOrderId: paymentInfo.merchantOrderId,
            mpStatus: paymentInfo.status,
            mpPaidAmount: paidAmount,
          },
        }
      );

      const fresh = await Order.findById(order._id);
      if (fresh) {
        fresh.notes = appendNote(fresh.notes, `Monto no coincide. Paid=${paidAmount} Order=${expected}`);
        await fresh.save();
      }

      console.warn("[MP WEBHOOK] amount mismatch", {
        orderId: String(order._id),
        paymentId: paymentInfo.paymentId,
        paidAmount,
        expected,
      });

      return res.status(200).json({ ok: true });
    }

    if (paymentInfo.status !== "approved") {
      await saveNonApprovedPaymentState({ orderId: order._id, paymentInfo });

      console.log("[MP WEBHOOK] non-approved payment saved", {
        orderId: String(order._id),
        paymentId: paymentInfo.paymentId,
        status: paymentInfo.status,
        statusDetail: paymentInfo.statusDetail,
      });

      return res.status(200).json({ ok: true });
    }

    const applied = await applyApprovedOrderWithRetry({
      orderId: order._id,
      paymentInfo,
    });

    if (!applied.ok) {
      console.warn("[MP WEBHOOK] approved payment not applied", {
        orderId: String(order._id),
        paymentId: paymentInfo.paymentId,
        error: applied.error || "unknown",
      });
      return res.status(200).json({ ok: true });
    }

    sendPaidNotifications(String(order._id), applied.manual ? "MP_PUBLIC" : "MP");

    console.log("[MP WEBHOOK] approved payment processed", {
      orderId: String(order._id),
      paymentId: paymentInfo.paymentId,
      applied: Boolean(applied.applied),
      alreadyApplied: Boolean(applied.alreadyApplied),
      manual: Boolean(applied.manual),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("MP webhook error:", err);

    // Mercado Pago reintenta si no recibe 2xx. Para evitar loops infinitos,
    // respondemos 200 y dejamos el error en logs.
    return res.status(200).json({ ok: true });
  }
});

export default router;
