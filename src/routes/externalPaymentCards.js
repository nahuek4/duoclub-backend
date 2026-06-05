// backend/src/routes/externalPaymentCards.js
import express from "express";
import crypto from "crypto";
import mongoose from "mongoose";

import { protect, adminOnly } from "../middleware/auth.js";
import ExternalPaymentCard from "../models/ExternalPaymentCard.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { logActivity, buildUserSubject } from "../lib/activityLogger.js";

const router = express.Router();

const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "NUT"]);

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  NUT: "Nutrición",
};

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKey(value, { allowEmpty = true } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return allowEmpty ? "" : null;

  const upper = stripAccents(raw).toUpperCase().trim();
  if (upper === "AR") return "RA";
  if (upper === "KINEDEPO" || upper === "KINE-DEPO") return "KD";
  if (ALLOWED_SERVICE_KEYS.has(upper)) return upper;

  const s = stripAccents(raw).toLowerCase().trim();
  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilax") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("nutric")) return "NUT";

  return allowEmpty ? "" : null;
}

function serviceNameFromKey(serviceKey) {
  const sk = normalizeServiceKey(serviceKey, { allowEmpty: true });
  return sk ? SERVICE_KEY_TO_NAME[sk] || sk : "";
}

function slugify(value) {
  return stripAccents(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getFrontBaseUrl() {
  return String(process.env.FRONT_BASE_URL || "https://app.duoclub.ar").replace(/\/+$/, "");
}

function buildExternalPaymentUrl(slug) {
  return `${getFrontBaseUrl()}/pago/${encodeURIComponent(String(slug || ""))}`;
}

function publicStatusForCard(card = {}) {
  if (!card?.active) return "inactive";

  const exp = card?.expiresAt ? new Date(card.expiresAt) : null;
  if (exp && exp.getTime() <= Date.now()) return "expired";

  const max = card?.maxApprovedPayments;
  if (max !== null && max !== undefined && Number(max) > 0) {
    if (Number(card.approvedPaymentsCount || 0) >= Number(max)) return "sold_out";
  }

  return "active";
}

function serializeCard(card = {}, { includeAdmin = false } = {}) {
  const obj = typeof card?.toObject === "function" ? card.toObject() : card;
  const serviceKey = normalizeServiceKey(obj?.serviceKey, { allowEmpty: true });

  const base = {
    id: String(obj?._id || ""),
    title: String(obj?.title || ""),
    description: String(obj?.description || ""),
    slug: String(obj?.slug || ""),
    amount: Number(obj?.amount || 0),
    active: Boolean(obj?.active),
    reusable: obj?.reusable !== false,
    maxApprovedPayments:
      obj?.maxApprovedPayments === null || obj?.maxApprovedPayments === undefined
        ? null
        : Number(obj.maxApprovedPayments),
    expiresAt: obj?.expiresAt || null,
    addsCredits: Boolean(obj?.addsCredits),
    serviceKey,
    serviceName: serviceNameFromKey(serviceKey),
    sessionsQty: Number(obj?.sessionsQty || 0),
    assignmentMode: String(obj?.assignmentMode || "manual"),
    approvedPaymentsCount: Number(obj?.approvedPaymentsCount || 0),
    totalApprovedAmount: Number(obj?.totalApprovedAmount || 0),
    publicUrl: buildExternalPaymentUrl(obj?.slug || ""),
    status: publicStatusForCard(obj),
    createdAt: obj?.createdAt || null,
    updatedAt: obj?.updatedAt || null,
  };

  if (!includeAdmin) {
    return {
      title: base.title,
      description: base.description,
      slug: base.slug,
      amount: base.amount,
      addsCredits: base.addsCredits,
      serviceName: base.serviceName,
      sessionsQty: base.sessionsQty,
      status: base.status,
      publicUrl: base.publicUrl,
    };
  }

  return base;
}

function buildOrderPaymentTitleFromCard(card = {}) {
  const title = cleanString(card.title || "DUO - Pago");
  if (!card.addsCredits) return title;

  const sessions = Math.max(1, Number(card.sessionsQty || 1));
  const serviceName = serviceNameFromKey(card.serviceKey);
  return `${title} · ${sessions} ${sessions === 1 ? "sesión" : "sesiones"}${serviceName ? ` de ${serviceName}` : ""}`;
}

async function createMpPreference({ order, card }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) return { ok: false, error: "MP_ACCESS_TOKEN no configurado." };

  const FRONT_BASE = getFrontBaseUrl();
  const slug = String(card?.slug || order?.externalPaymentCardSlug || "");
  const backBase = `${FRONT_BASE}/pago/${encodeURIComponent(slug)}`;
  const amountToCharge = Number(order.totalFinal ?? order.total ?? order.price ?? 0);
  const paymentTitle = buildOrderPaymentTitleFromCard(card);

  const body = {
    items: [
      {
        title: paymentTitle || "DUO - Pago",
        quantity: 1,
        currency_id: "ARS",
        unit_price: amountToCharge,
      },
    ],
    external_reference: String(order._id),
    metadata: {
      orderId: String(order._id),
      externalPaymentCardId: String(card?._id || ""),
      externalPaymentCardSlug: slug,
      externalPayment: true,
      addsCredits: Boolean(card?.addsCredits),
      autoApply: Boolean(order?.externalPaymentAutoApply),
    },
    back_urls: {
      success: `${backBase}?mp=success`,
      pending: `${backBase}?mp=pending`,
      failure: `${backBase}?mp=failure`,
    },
    auto_return: "approved",
    notification_url: process.env.MP_WEBHOOK_URL || undefined,
  };

  const resp = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return { ok: false, error: data?.message || "Error creando preferencia MP" };
  }

  return { ok: true, preferenceId: data.id, init_point: data.init_point };
}

function buildCreatePayload(body = {}, userId = null) {
  const title = cleanString(body.title);
  const description = cleanString(body.description);
  const amount = normalizeMoney(body.amount ?? body.price ?? body.total);
  const inputSlug = cleanString(body.slug);
  const slug = slugify(inputSlug || title);
  const addsCredits = Boolean(body.addsCredits);
  const serviceKey = addsCredits ? normalizeServiceKey(body.serviceKey, { allowEmpty: false }) : "";
  const sessionsQty = addsCredits ? Math.trunc(Number(body.sessionsQty ?? body.sessions ?? body.credits ?? 0)) : 0;

  let expiresAt = null;
  const rawExpiresAt = cleanString(body.expiresAt);
  if (rawExpiresAt) {
    const parsed = new Date(rawExpiresAt);
    if (!Number.isNaN(parsed.getTime())) expiresAt = parsed;
  }

  let maxApprovedPayments = null;
  const rawMax = body.maxApprovedPayments ?? body.maxUses ?? "";
  if (rawMax !== "" && rawMax !== null && rawMax !== undefined) {
    const parsedMax = Number(rawMax);
    maxApprovedPayments =
      Number.isFinite(parsedMax) && parsedMax > 0 ? Math.trunc(parsedMax) : null;
  }

  return {
    title,
    description,
    slug,
    amount,
    active: body.active !== false,
    reusable: body.reusable !== false,
    maxApprovedPayments,
    expiresAt,
    addsCredits,
    serviceKey: serviceKey || "",
    sessionsQty,
    assignmentMode:
      addsCredits && String(body.assignmentMode || "").trim() === "manual"
        ? "manual"
        : addsCredits
          ? "auto_by_email"
          : "manual",
    updatedBy: userId,
    createdBy: userId,
  };
}

function validateCardPayload(payload = {}, { partial = false } = {}) {
  if (!partial || payload.title !== undefined) {
    if (!cleanString(payload.title)) return "Título requerido.";
  }

  if (!partial || payload.amount !== undefined) {
    if (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) <= 0) {
      return "Monto inválido.";
    }
  }

  if (!partial || payload.slug !== undefined) {
    if (!slugify(payload.slug || payload.title)) return "Link/slug inválido.";
  }

  if (payload.addsCredits) {
    if (!normalizeServiceKey(payload.serviceKey, { allowEmpty: false })) {
      return "Servicio requerido para sumar sesiones.";
    }

    const sessions = Number(payload.sessionsQty || 0);
    if (!Number.isInteger(sessions) || sessions <= 0) {
      return "Cantidad de sesiones inválida.";
    }
  }

  return "";
}

/* =========================================================
   ADMIN: listar tarjetas
========================================================= */
router.get("/admin", protect, adminOnly, async (req, res) => {
  try {
    const items = await ExternalPaymentCard.find({})
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      items: items.map((x) => serializeCard(x, { includeAdmin: true })),
    });
  } catch (err) {
    console.error("GET /external-payment-cards/admin", err);
    return res.status(500).json({ error: "No se pudieron cargar las tarjetas externas." });
  }
});

/* =========================================================
   ADMIN: crear tarjeta
========================================================= */
router.post("/admin", protect, adminOnly, async (req, res) => {
  try {
    const payload = buildCreatePayload(req.body || {}, req.user?._id || null);
    const validationError = validateCardPayload(payload);
    if (validationError) return res.status(400).json({ error: validationError });

    const exists = await ExternalPaymentCard.findOne({ slug: payload.slug }).lean();
    if (exists) {
      return res.status(409).json({ error: "Ya existe una tarjeta externa con ese link." });
    }

    const card = await ExternalPaymentCard.create(payload);

    await logActivity({
      req,
      category: "orders",
      action: "external_payment_card_created",
      entity: "externalPaymentCard",
      entityId: card._id,
      title: "Tarjeta externa creada",
      description: "Se creó una tarjeta externa reutilizable con link público.",
      subject: buildUserSubject(req.user),
      meta: {
        slug: card.slug,
        amount: card.amount,
        addsCredits: card.addsCredits,
        serviceKey: card.serviceKey,
        sessionsQty: card.sessionsQty,
      },
    });

    return res.status(201).json({
      ok: true,
      item: serializeCard(card, { includeAdmin: true }),
    });
  } catch (err) {
    console.error("POST /external-payment-cards/admin", err);
    const isDuplicate = err?.code === 11000;
    return res.status(isDuplicate ? 409 : 500).json({
      error: isDuplicate
        ? "Ya existe una tarjeta externa con ese link."
        : err?.message || "No se pudo crear la tarjeta externa.",
    });
  }
});

/* =========================================================
   ADMIN: editar tarjeta
========================================================= */
router.put("/admin/:id", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID inválido." });
    }

    const card = await ExternalPaymentCard.findById(id);
    if (!card) return res.status(404).json({ error: "Tarjeta externa no encontrada." });

    const payload = buildCreatePayload(
      {
        ...card.toObject(),
        ...(req.body || {}),
      },
      req.user?._id || null
    );

    payload.createdBy = card.createdBy || req.user?._id || null;
    payload.approvedPaymentsCount = card.approvedPaymentsCount || 0;
    payload.totalApprovedAmount = card.totalApprovedAmount || 0;

    const validationError = validateCardPayload(payload);
    if (validationError) return res.status(400).json({ error: validationError });

    const slugExists = await ExternalPaymentCard.findOne({
      _id: { $ne: card._id },
      slug: payload.slug,
    }).lean();

    if (slugExists) {
      return res.status(409).json({ error: "Ya existe otra tarjeta externa con ese link." });
    }

    Object.assign(card, payload);
    await card.save();

    await logActivity({
      req,
      category: "orders",
      action: "external_payment_card_updated",
      entity: "externalPaymentCard",
      entityId: card._id,
      title: "Tarjeta externa editada",
      description: "Se editó una tarjeta externa reutilizable.",
      subject: buildUserSubject(req.user),
      meta: {
        slug: card.slug,
        amount: card.amount,
        addsCredits: card.addsCredits,
        serviceKey: card.serviceKey,
        sessionsQty: card.sessionsQty,
      },
    });

    return res.json({
      ok: true,
      item: serializeCard(card, { includeAdmin: true }),
    });
  } catch (err) {
    console.error("PUT /external-payment-cards/admin/:id", err);
    const isDuplicate = err?.code === 11000;
    return res.status(isDuplicate ? 409 : 500).json({
      error: isDuplicate
        ? "Ya existe una tarjeta externa con ese link."
        : err?.message || "No se pudo editar la tarjeta externa.",
    });
  }
});

/* =========================================================
   ADMIN: eliminar o desactivar
========================================================= */
router.delete("/admin/:id", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID inválido." });
    }

    const card = await ExternalPaymentCard.findById(id);
    if (!card) return res.status(404).json({ error: "Tarjeta externa no encontrada." });

    const hasOrders = await Order.exists({ externalPaymentCard: card._id });

    if (hasOrders || Number(card.approvedPaymentsCount || 0) > 0) {
      card.active = false;
      card.updatedBy = req.user?._id || null;
      await card.save();

      return res.json({
        ok: true,
        softDeleted: true,
        item: serializeCard(card, { includeAdmin: true }),
        message: "La tarjeta tiene pagos asociados, por seguridad se desactivó en lugar de eliminarse.",
      });
    }

    await card.deleteOne();

    await logActivity({
      req,
      category: "orders",
      action: "external_payment_card_deleted",
      entity: "externalPaymentCard",
      entityId: card._id,
      title: "Tarjeta externa eliminada",
      description: "Se eliminó una tarjeta externa sin pagos asociados.",
      subject: buildUserSubject(req.user),
      deletedSnapshot: card.toObject(),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /external-payment-cards/admin/:id", err);
    return res.status(500).json({ error: "No se pudo eliminar la tarjeta externa." });
  }
});

/* =========================================================
   ADMIN: pagos por tarjeta
========================================================= */
router.get("/admin/:id/orders", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID inválido." });
    }

    const orders = await Order.find({ externalPaymentCard: id })
      .populate("user", "name lastName fullName email")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({ ok: true, items: orders });
  } catch (err) {
    console.error("GET /external-payment-cards/admin/:id/orders", err);
    return res.status(500).json({ error: "No se pudieron cargar los pagos de la tarjeta." });
  }
});

/* =========================================================
   PÚBLICO: obtener tarjeta por link
========================================================= */
router.get("/public/:slug", async (req, res) => {
  try {
    const slug = slugify(req.params?.slug || "");
    if (!slug) return res.status(400).json({ error: "Link inválido." });

    const card = await ExternalPaymentCard.findOne({ slug }).lean();
    if (!card) return res.status(404).json({ error: "Tarjeta no encontrada." });

    return res.json({
      ok: true,
      item: serializeCard(card, { includeAdmin: false }),
    });
  } catch (err) {
    console.error("GET /external-payment-cards/public/:slug", err);
    return res.status(500).json({ error: "No se pudo abrir la tarjeta." });
  }
});

/* =========================================================
   PÚBLICO: pagar tarjeta reutilizable
========================================================= */
router.post("/public/:slug/pay", async (req, res) => {
  try {
    const slug = slugify(req.params?.slug || "");
    if (!slug) return res.status(400).json({ error: "Link inválido." });

    const card = await ExternalPaymentCard.findOne({ slug });
    if (!card) return res.status(404).json({ error: "Tarjeta no encontrada." });

    if (!card.isPubliclyPayable()) {
      return res.status(409).json({
        error:
          publicStatusForCard(card) === "expired"
            ? "Este link ya venció."
            : publicStatusForCard(card) === "sold_out"
              ? "Este link ya alcanzó el máximo de pagos."
              : "Este link no está activo.",
      });
    }

    const customerName = cleanString(req.body?.customerName || req.body?.name).replace(/\s+/g, " ");
    const customerEmail = normalizeEmail(req.body?.customerEmail || req.body?.email);
    const customerPhone = cleanString(req.body?.customerPhone || req.body?.phone);

    if (!customerName || customerName.length < 3) {
      return res.status(400).json({ error: "Ingresá nombre y apellido para identificar el pago." });
    }

    if (!customerEmail || !customerEmail.includes("@")) {
      return res.status(400).json({ error: "Ingresá un email válido." });
    }

    const amount = Number(card.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(500).json({ error: "La tarjeta tiene un monto inválido." });
    }

    let matchedUser = null;
    const shouldAutoAssign =
      Boolean(card.addsCredits) &&
      String(card.assignmentMode || "") === "auto_by_email";

    if (shouldAutoAssign) {
      matchedUser = await User.findOne({ email: customerEmail });
    }

    const canAutoApply = Boolean(card.addsCredits && shouldAutoAssign && matchedUser);
    const serviceKey = normalizeServiceKey(card.serviceKey, { allowEmpty: true });
    const sessions = Math.max(0, Math.trunc(Number(card.sessionsQty || 0)));
    const serviceName = serviceNameFromKey(serviceKey);
    const label = buildOrderPaymentTitleFromCard(card);

    const orderItems = card.addsCredits
      ? [
          {
            kind: "CREDITS",
            serviceKey,
            credits: sessions,
            label,
            qty: 1,
            basePrice: amount,
            regularPrice: amount,
            price: amount,
          },
        ]
      : [
          {
            kind: "MANUAL_SERVICE",
            serviceKey: "",
            credits: 0,
            label,
            qty: 1,
            basePrice: amount,
            regularPrice: amount,
            price: amount,
          },
        ];

    const order = await Order.create({
      user: matchedUser?._id || null,
      payMethod: "MP",
      items: orderItems,
      totalBase: amount,
      total: amount,
      discountPercent: 0,
      discountAmount: 0,
      coverageDiscountAmount: 0,
      plusDiscountAmount: 0,
      discountReason: "",
      totalFinal: amount,
      status: "pending",
      applied: false,
      creditsApplied: false,

      publicPaymentLink: true,
      publicPaymentToken: crypto.randomBytes(24).toString("hex"),
      publicPaymentExpiresAt: null,
      publicPaymentUrl: buildExternalPaymentUrl(card.slug),

      manualFulfillmentRequired: !canAutoApply,
      createdByAdmin: false,
      createdByAdminId: null,

      customerName,
      customerEmail,
      customerPhone,

      serviceKey: card.addsCredits ? serviceKey : "",
      credits: card.addsCredits ? sessions : 0,
      price: amount,
      label,

      externalPaymentCard: card._id,
      externalPaymentCardSlug: card.slug,
      externalPaymentCardTitle: card.title,
      externalPaymentAddsCredits: Boolean(card.addsCredits),
      externalPaymentAutoApply: canAutoApply,
      externalPaymentAssignmentMode: String(card.assignmentMode || "manual"),
      externalPaymentMatchedUser: matchedUser?._id || null,

      notes: canAutoApply
        ? `Pago externo reutilizable. Si MP aprueba, acredita ${sessions} sesión(es) de ${serviceName}.`
        : card.addsCredits
          ? "Pago externo reutilizable. No se encontró usuario por email o la asignación es manual; requiere gestión manual."
          : "Pago externo reutilizable. No acredita sesiones automáticamente.",
    });

    const mp = await createMpPreference({ order, card });
    if (!mp.ok) {
      order.notes = [order.notes, mp.error].filter(Boolean).join("\n");
      await order.save();
      return res.status(500).json({ error: mp.error });
    }

    order.mpPreferenceId = mp.preferenceId;
    order.mpInitPoint = mp.init_point;
    await order.save();

    return res.status(201).json({
      ok: true,
      init_point: mp.init_point,
      orderId: String(order._id),
      manualFulfillmentRequired: Boolean(order.manualFulfillmentRequired),
      autoApply: Boolean(order.externalPaymentAutoApply),
    });
  } catch (err) {
    console.error("POST /external-payment-cards/public/:slug/pay", err);
    return res.status(500).json({ error: err?.message || "No se pudo iniciar el pago." });
  }
});

export default router;
