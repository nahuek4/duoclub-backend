import express from "express";
import mongoose from "mongoose";

import { protect, adminOnly } from "../middleware/auth.js";
import ActivityLog from "../models/ActivityLog.js";
import Order from "../models/Order.js";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import Evaluation from "../models/Evaluation.js";

const router = express.Router();
router.use(protect, adminOnly);

function parseDateStart(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDateEnd(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function resolveRange(query = {}) {
  const preset = String(query.preset || "month").toLowerCase();
  const now = new Date();

  if (query.from || query.to) {
    const from =
      parseDateStart(query.from) ||
      new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const to = parseDateEnd(query.to) || now;
    return { from, to, preset: "custom" };
  }

  if (preset === "day") {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
      to: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
      preset,
    };
  }

  if (preset === "year") {
    return {
      from: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0),
      to: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
      preset,
    };
  }

  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
    to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    preset: "month",
  };
}

function buildDateMatch(field, from, to) {
  return { [field]: { $gte: from, $lte: to } };
}

function buildActivityFilters(query, from, to) {
  const match = buildDateMatch("createdAt", from, to);

  // Los turnos asignados por admin ahora se agrupan en una sola actividad
  // con meta.items. Ocultamos el log legacy por turno para que el dashboard
  // no muestre 8/9 notificaciones separadas por una misma asignación.
  match.action = { $ne: "appointment_assigned_by_admin" };

  if (query.category) match.category = String(query.category).trim();
  if (query.action) match.action = String(query.action).trim();
  if (query.actorRole) match["actor.role"] = String(query.actorRole).trim();

  const search = String(query.search || "").trim();
  if (search) {
    match.$or = [
      { title: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { "actor.name": { $regex: search, $options: "i" } },
      { "actor.fullName": { $regex: search, $options: "i" } },
      { "subject.name": { $regex: search, $options: "i" } },
      { "subject.fullName": { $regex: search, $options: "i" } },
      { entity: { $regex: search, $options: "i" } },
      { action: { $regex: search, $options: "i" } },
    ];
  }

  return match;
}

function fullNameOf(doc) {
  if (!doc) return "";
  const direct = String(doc.fullName || "").trim();
  if (direct) return direct;
  const name = String(doc.name || "").trim();
  const lastName = String(doc.lastName || "").trim();
  return [name, lastName].filter(Boolean).join(" ").trim();
}

function pickOrderTotal(order) {
  return Number(order?.totalFinal ?? order?.total ?? 0);
}

function normalizeOrderStatus(status) {
  return String(status || "").toLowerCase().trim();
}

function isPaidOrderStatus(status) {
  const s = normalizeOrderStatus(status);
  return s === "paid" || s === "approved";
}

function isPendingOrderStatus(status) {
  return normalizeOrderStatus(status) === "pending";
}

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación activa",
  RF: "Reeducación funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

const DEBT_SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN"];
const DEBT_HISTORY_SCOPE_LABEL = "Historial completo disponible";

const EXCLUDED_DEBT_USER_IDS = new Set([
  "692c8747ac97e1bf8ba86839", // Admin DUO / usuario de prueba operativo
]);

const EXCLUDED_DEBT_EMAILS = new Set([
  "admin@duoclub.ar",
]);

const EXCLUDED_DEBT_ROLES = new Set([
  "admin",
  "staff",
  "profesor",
  "professor",
  "coach",
]);

const DEBT_HISTORY_ACTIONS = new Set([
  "fixed_schedule_monthly_debt",
  "fixed_schedule_debt_created",
  "fixed_schedule_debt_settled",
  "fixed_schedule_debt_settled_by_cancelled_credit",
  "fixed_schedule_debt_settled_by_plan_delete",
  "fixed_schedule_debt_released_by_cancel",
  "fixed_schedule_debt_released_by_plan_delete",
  "fixed_schedule_auto_released_unpaid",
  "fixed_schedule_monthly_turn_completed",
  "fixed_schedule_monthly_reserved",
  "fixed_schedule_monthly_debit",
]);

function normalizeText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeServiceKey(serviceKey) {
  const key = String(serviceKey || "").toUpperCase().trim();
  if (!key) return "";
  if (key === "AR") return "RA";
  if (SERVICE_KEY_TO_NAME[key]) return key;

  const text = normalizeText(serviceKey);
  if (text.includes("entrenamiento") && text.includes("personal")) return "EP";
  if (text.includes("rehabilitacion") && text.includes("activa")) return "RA";
  if (text.includes("reeducacion") && text.includes("funcional")) return "RF";
  if (text.includes("kinefilaxia") || (text.includes("kine") && text.includes("deport"))) return "KD";
  if (text.includes("synergy") || text.includes("sinergia")) return "SYN";
  if (text.includes("nutricion")) return "NUT";
  if (text.includes("evaluacion")) return "PE";

  return "";
}

function translateServiceKey(serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  return SERVICE_KEY_TO_NAME[key] || String(serviceKey || "").toUpperCase().trim() || "";
}

function sumDebtObject(raw = {}) {
  return DEBT_SERVICE_KEYS.reduce((acc, sk) => {
    const value = Number(raw?.[sk] || 0);
    return acc + (Number.isFinite(value) ? Math.max(0, value) : 0);
  }, 0);
}

function normalizeDebtByService(raw = {}) {
  return DEBT_SERVICE_KEYS.reduce((acc, sk) => {
    const value = Number(raw?.[sk] || 0);
    acc[sk] = Number.isFinite(value) ? Math.max(0, value) : 0;
    return acc;
  }, {});
}

function emptyDebtByService() {
  return DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    acc[serviceKey] = 0;
    return acc;
  }, {});
}

function sumMapValues(map = {}) {
  return DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    const value = Number(map?.[serviceKey] || 0);
    return acc + (Number.isFinite(value) ? Math.max(0, value) : 0);
  }, 0);
}

function positiveDiffByService(left = {}, right = {}) {
  return DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    acc[serviceKey] = Math.max(
      0,
      Number(left?.[serviceKey] || 0) - Number(right?.[serviceKey] || 0)
    );
    return acc;
  }, {});
}

function isExcludedDebtUser(user = {}) {
  const id = String(user?._id || user?.id || "").trim();
  const email = String(user?.email || "").toLowerCase().trim();
  const role = String(user?.role || "").toLowerCase().trim();

  return (
    EXCLUDED_DEBT_USER_IDS.has(id) ||
    EXCLUDED_DEBT_EMAILS.has(email) ||
    EXCLUDED_DEBT_ROLES.has(role)
  );
}

function classifyDebtHistoryItem(item = {}) {
  const action = String(item.action || "").trim();

  if (
    action === "fixed_schedule_monthly_debt" ||
    action === "fixed_schedule_debt_created"
  ) {
    return {
      type: "debt_created",
      label: "Asumió deuda",
      sign: 1,
    };
  }

  if (
    action === "fixed_schedule_debt_settled" ||
    action === "fixed_schedule_debt_settled_by_cancelled_credit" ||
    action === "fixed_schedule_debt_settled_by_plan_delete"
  ) {
    return {
      type: "debt_paid",
      label: "Deuda saldada con créditos",
      sign: -1,
    };
  }

  if (
    action === "fixed_schedule_debt_released_by_cancel" ||
    action === "fixed_schedule_debt_released_by_plan_delete"
  ) {
    return {
      type: "debt_released",
      label: "Deuda liberada",
      sign: -1,
    };
  }

  if (action === "fixed_schedule_auto_released_unpaid") {
    return {
      type: "debt_auto_released_notice",
      label: "Turnos futuros liberados",
      sign: 0,
    };
  }

  if (action === "fixed_schedule_monthly_turn_completed") {
    return {
      type: "fixed_turn_completed",
      label: "Turno fijo completado",
      sign: 0,
    };
  }

  if (action === "fixed_schedule_monthly_reserved") {
    return {
      type: "monthly_debt_notice",
      label: "Deuda legacy mensual",
      sign: 0,
    };
  }

  if (action === "fixed_schedule_monthly_debit") {
    return {
      type: "fixed_credit_debited",
      label: "Crédito debitado por turno fijo",
      sign: 0,
    };
  }

  return {
    type: "movement",
    label: item.title || "Movimiento",
    sign: 0,
  };
}

function debtEventFromHistoryItem(item = {}, index = 0) {
  const classified = classifyDebtHistoryItem(item);
  const serviceKey = normalizeServiceKey(item.serviceKey || item.service || item.serviceName);
  const rawQty = Number(item.qty ?? item.amount ?? item.value ?? 0);
  const qty = Number.isFinite(rawQty) ? Math.abs(rawQty) : 0;
  const createdAt = item.createdAt || item.date || null;

  return {
    id: String(item._id || `${createdAt || "event"}-${index}`),
    type: classified.type,
    label: classified.label,
    sign: classified.sign,
    serviceKey,
    serviceName: translateServiceKey(serviceKey) || item.serviceName || item.service || "",
    qty,
    date: item.date || "",
    time: item.time || "",
    title: item.title || classified.label,
    message: item.message || "",
    appointmentId: item.appointmentId || null,
    fixedScheduleId: item.fixedScheduleId || null,
    createdAt,
  };
}

function debtEventFromAppointment(ap = {}, index = 0) {
  const serviceKey = normalizeServiceKey(ap.serviceKey || ap.service || ap.serviceName);
  const qty = Math.max(1, Number(ap.fixedDebtAmount || 1));

  return {
    id: `ap-${String(ap._id || index)}`,
    type: "active_debt_marker",
    label: "Turno en deuda activo",
    sign: 0,
    serviceKey,
    serviceName: translateServiceKey(serviceKey) || ap.serviceName || ap.service || "",
    qty,
    date: ap.date || "",
    time: ap.time || "",
    title: "Turno fijo activo marcado con deuda",
    message: "Marcador operativo de deuda. La deuda real exigible se toma desde el saldo del usuario.",
    appointmentId: ap._id || null,
    fixedScheduleId: ap.fixedScheduleId || null,
    createdAt: ap.updatedAt || ap.createdAt || null,
  };
}

function sumEventsByService(events = [], predicate = () => true) {
  return DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    acc[serviceKey] = events
      .filter((event) => event.serviceKey === serviceKey && predicate(event))
      .reduce((sum, event) => sum + Number(event.qty || 0), 0);
    return acc;
  }, {});
}

function estimateAutoReleasedByService({
  currentDebtByService = {},
  createdByService = {},
  settledByService = {},
} = {}) {
  return DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    const generated = Number(createdByService[serviceKey] || 0);
    const settled = Number(settledByService[serviceKey] || 0);
    const current = Number(currentDebtByService[serviceKey] || 0);
    acc[serviceKey] = Math.max(0, generated - settled - current);
    return acc;
  }, {});
}

function explicitAutoReleasedByService(events = []) {
  return DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    acc[serviceKey] = events
      .filter((event) => event.type === "debt_auto_released_notice" && event.serviceKey === serviceKey)
      .reduce((sum, event) => sum + Math.max(0, Number(event.qty || 0)), 0);
    return acc;
  }, {});
}

function classifyDebtRow({
  currentDebt = 0,
  unexplainedGenerated = 0,
  legacyCurrentDebt = 0,
  historicalOverResolved = 0,
  totalAutoReleased = 0,
} = {}) {
  if (unexplainedGenerated > 0) {
    return {
      reconciliationStatus: "review",
      reconciliationLabel: "Revisar",
      reconciliationTone: "warning",
      reconciliationMessage: "Hay deuda generada que no queda explicada por pagos, liberaciones o saldo actual.",
      needsManualReview: true,
    };
  }

  if (currentDebt > 0 && legacyCurrentDebt > 0) {
    return {
      reconciliationStatus: "legacy_debt",
      reconciliationLabel: "Deuda legacy",
      reconciliationTone: "dark",
      reconciliationMessage: "La deuda actual existe en el usuario, pero su origen viene de historial legacy o saldo arrastrado.",
      needsManualReview: false,
    };
  }

  if (currentDebt > 0) {
    return {
      reconciliationStatus: "active_debt",
      reconciliationLabel: "Deuda actual",
      reconciliationTone: "danger",
      reconciliationMessage: "Deuda real exigible del usuario.",
      needsManualReview: false,
    };
  }

  if (historicalOverResolved > 0) {
    return {
      reconciliationStatus: "historical_over_resolved",
      reconciliationLabel: "Histórico",
      reconciliationTone: "secondary",
      reconciliationMessage: "El historial viejo muestra más saldos/liberaciones que deuda generada. No hay deuda actual para cobrar.",
      needsManualReview: false,
    };
  }

  if (totalAutoReleased > 0) {
    return {
      reconciliationStatus: "auto_released",
      reconciliationLabel: "Auto liberado",
      reconciliationTone: "info",
      reconciliationMessage: "Cierra por liberación automática de turnos futuros.",
      needsManualReview: false,
    };
  }

  return {
    reconciliationStatus: "ok",
    reconciliationLabel: "OK",
    reconciliationTone: "success",
    reconciliationMessage: "Conciliado.",
    needsManualReview: false,
  };
}

function extractPaidCreditEventsFromOrder(order = {}) {
  const orderDate = order.paidAt || order.approvedAt || order.createdAt || null;

  const base = {
    orderId: order._id || null,
    createdAt: orderDate,
    title: "Créditos pagados por orden",
    message: `Orden ${String(order._id || "").slice(-6) || ""}${
      pickOrderTotal(order) ? ` · ${pickOrderTotal(order)}` : ""
    }`,
  };

  const items = Array.isArray(order.items) ? order.items : [];
  const events = items
    .map((item, index) => {
      const kind = String(item?.kind || "").toUpperCase().trim();
      const serviceKey = normalizeServiceKey(item?.serviceKey || item?.service || item?.serviceName);
      const qty = Math.max(0, Number(item?.credits || item?.quantity || 0));

      if (kind && kind !== "CREDITS") return null;
      if (!serviceKey || qty <= 0) return null;

      return {
        id: `order-${String(order._id || "order")}-${index}`,
        type: "paid_order_credits",
        label: "Créditos pagados",
        sign: 0,
        serviceKey,
        serviceName: translateServiceKey(serviceKey),
        qty,
        date: "",
        time: "",
        ...base,
        title: item?.label || base.title,
      };
    })
    .filter(Boolean);

  if (events.length) return events;

  const serviceKey = normalizeServiceKey(order.serviceKey || order.service || order.serviceName);
  const qty = Math.max(0, Number(order.credits || 0));
  if (!serviceKey || qty <= 0) return [];

  return [
    {
      id: `order-${String(order._id || "order")}`,
      type: "paid_order_credits",
      label: "Créditos pagados",
      sign: 0,
      serviceKey,
      serviceName: translateServiceKey(serviceKey),
      qty,
      date: "",
      time: "",
      ...base,
    },
  ];
}

function extractManualCreditEventsFromLog(log = {}) {
  const before = log?.diff?.before?.byService || {};
  const after = log?.diff?.after?.byService || {};
  const actorName =
    String(log?.actor?.fullName || "").trim() ||
    String(log?.actor?.name || "").trim() ||
    String(log?.actor?.email || "").trim() ||
    "Admin/staff";

  return DEBT_SERVICE_KEYS.map((serviceKey) => {
    const beforeQty = Number(before?.[serviceKey] || 0);
    const afterQty = Number(after?.[serviceKey] || 0);
    const delta = afterQty - beforeQty;
    if (!Number.isFinite(delta) || delta === 0) return null;

    const isPositive = delta > 0;

    return {
      id: `manual-credit-${String(log._id || "log")}-${serviceKey}`,
      type: isPositive ? "admin_assigned_credits" : "admin_removed_credits",
      label: isPositive ? "Créditos asignados" : "Créditos retirados",
      sign: 0,
      serviceKey,
      serviceName: translateServiceKey(serviceKey),
      qty: Math.abs(delta),
      date: "",
      time: "",
      title: isPositive
        ? `Créditos asignados por ${actorName}`
        : `Créditos retirados por ${actorName}`,
      message: log.description || log.title || "",
      activityLogId: log._id || null,
      createdAt: log.createdAt || null,
    };
  }).filter(Boolean);
}

function decorateDebtUser(user = {}, appointmentEvents = [], orderEvents = [], manualCreditEvents = []) {
  const history = Array.isArray(user.history) ? user.history : [];
  const currentDebtByService = normalizeDebtByService(user.fixedScheduleDebt || {});
  const currentDebt = sumDebtObject(currentDebtByService);

  const historyEvents = history
    .filter((item) => DEBT_HISTORY_ACTIONS.has(String(item?.action || "").trim()))
    .map((item, index) => debtEventFromHistoryItem(item, index));

  const historyAppointmentIds = new Set(
    historyEvents
      .map((event) => String(event.appointmentId || ""))
      .filter(Boolean)
  );

  const safeAppointmentEvents = appointmentEvents.filter((event) => {
    const appointmentId = String(event.appointmentId || "");
    return !appointmentId || !historyAppointmentIds.has(appointmentId);
  });

  const events = [
    ...historyEvents,
    ...safeAppointmentEvents,
    ...orderEvents,
    ...manualCreditEvents,
  ]
    .filter(
      (event) =>
        (event.serviceKey ||
          event.type === "paid_order_credits" ||
          event.type === "admin_assigned_credits" ||
          event.type === "admin_removed_credits" ||
          event.type === "debt_auto_released_notice" ||
          event.type === "fixed_turn_completed" ||
          event.type === "monthly_debt_notice")
    )
    .sort((a, b) => {
      const ad = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bd = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bd - ad;
    });

  const totalCreated = events
    .filter((event) => event.sign > 0)
    .reduce((acc, event) => acc + Number(event.qty || 0), 0);

  const totalSettled = events
    .filter((event) => event.sign < 0)
    .reduce((acc, event) => acc + Number(event.qty || 0), 0);

  const createdByService = sumEventsByService(events, (event) => event.sign > 0);
  const settledByService = sumEventsByService(events, (event) => event.sign < 0);
  const activeDebtMarkersByService = sumEventsByService(
    safeAppointmentEvents,
    (event) => event.type === "active_debt_marker"
  );

  const autoReleaseNoticeCount = events.filter(
    (event) => event.type === "debt_auto_released_notice"
  ).length;

  const explicitAutoReleased = explicitAutoReleasedByService(events);
  const estimatedAutoReleasedByService = estimateAutoReleasedByService({
    currentDebtByService,
    createdByService,
    settledByService,
  });

  const autoReleasedByService = DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    const explicit = Number(explicitAutoReleased[serviceKey] || 0);
    if (explicit > 0) {
      acc[serviceKey] = explicit;
      return acc;
    }

    acc[serviceKey] =
      autoReleaseNoticeCount > 0
        ? Number(estimatedAutoReleasedByService[serviceKey] || 0)
        : 0;
    return acc;
  }, {});

  const totalAutoReleased = sumMapValues(autoReleasedByService);
  const totalResolved = totalSettled + totalAutoReleased;

  const expectedDebtByService = DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    acc[serviceKey] = Math.max(
      0,
      Number(createdByService[serviceKey] || 0) -
        Number(settledByService[serviceKey] || 0) -
        Number(autoReleasedByService[serviceKey] || 0)
    );
    return acc;
  }, {});

  const unexplainedGeneratedByService = positiveDiffByService(
    expectedDebtByService,
    currentDebtByService
  );

  const legacyCurrentDebtByService = positiveDiffByService(
    currentDebtByService,
    expectedDebtByService
  );

  const historicalOverResolvedByService = DEBT_SERVICE_KEYS.reduce((acc, serviceKey) => {
    const generated = Number(createdByService[serviceKey] || 0);
    const resolvedPlusCurrent =
      Number(settledByService[serviceKey] || 0) +
      Number(autoReleasedByService[serviceKey] || 0) +
      Number(currentDebtByService[serviceKey] || 0);

    acc[serviceKey] = Math.max(0, resolvedPlusCurrent - generated);
    return acc;
  }, {});

  const unexplainedDelta = sumMapValues(unexplainedGeneratedByService);
  const totalLegacyCurrentDebt = sumMapValues(legacyCurrentDebtByService);
  const totalHistoricalOverResolved = sumMapValues(historicalOverResolvedByService);

  const rowStatus = classifyDebtRow({
    currentDebt,
    unexplainedGenerated: unexplainedDelta,
    legacyCurrentDebt: totalLegacyCurrentDebt,
    historicalOverResolved: totalHistoricalOverResolved,
    totalAutoReleased,
  });

  const autoReleaseEvents = DEBT_SERVICE_KEYS.flatMap((serviceKey) => {
    const qty = Number(autoReleasedByService[serviceKey] || 0);
    if (qty <= 0) return [];

    return [
      {
        id: `auto-release-reconciled-${String(user._id || "user")}-${serviceKey}`,
        type: "debt_auto_released",
        label: "Turnos futuros liberados",
        sign: -1,
        serviceKey,
        serviceName: translateServiceKey(serviceKey),
        qty,
        date: "",
        time: "",
        title: "Turnos futuros liberados por regla automática",
        message:
          "No se cuenta como pago. Solo descuenta los turnos futuros liberados por deuda impaga.",
        appointmentId: null,
        fixedScheduleId: null,
        createdAt: events.find((event) => event.type === "debt_auto_released_notice")?.createdAt || null,
      },
    ];
  });

  const legacyDebtEvents = DEBT_SERVICE_KEYS.flatMap((serviceKey) => {
    const qty = Number(legacyCurrentDebtByService[serviceKey] || 0);
    if (qty <= 0) return [];

    return [
      {
        id: `legacy-current-debt-${String(user._id || "user")}-${serviceKey}`,
        type: "legacy_current_debt",
        label: "Deuda legacy",
        sign: 0,
        serviceKey,
        serviceName: translateServiceKey(serviceKey),
        qty,
        date: "",
        time: "",
        title: "Saldo actual heredado",
        message:
          "La deuda existe en el usuario, pero no queda explicada por los eventos nuevos de generación/saldo. Se muestra como deuda real legacy.",
        appointmentId: null,
        fixedScheduleId: null,
        createdAt: events[0]?.createdAt || user.updatedAt || user.createdAt || null,
      },
    ];
  });

  const displayEvents = [...events, ...autoReleaseEvents, ...legacyDebtEvents].sort((a, b) => {
    const ad = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bd = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bd - ad;
  });

  const totalPaidCredits = events
    .filter((event) => event.type === "paid_order_credits")
    .reduce((acc, event) => acc + Number(event.qty || 0), 0);

  const totalAdminAssignedCredits = events
    .filter((event) => event.type === "admin_assigned_credits")
    .reduce((acc, event) => acc + Number(event.qty || 0), 0);

  const totalAdminRemovedCredits = events
    .filter((event) => event.type === "admin_removed_credits")
    .reduce((acc, event) => acc + Number(event.qty || 0), 0);

  const totalIncomingCredits = totalPaidCredits + totalAdminAssignedCredits;

  const lastEventAt = events[0]?.createdAt || user.updatedAt || user.createdAt || null;
  const hasDebtContext = currentDebt > 0 || historyEvents.length > 0 || safeAppointmentEvents.length > 0;

  return {
    id: String(user._id || ""),
    fullName: fullNameOf(user) || "Usuario",
    email: user.email || "",
    phone: user.phone || "",
    role: user.role || "",
    currentDebt,
    currentDebtByService,
    currentDebtExigible: currentDebt,
    totalCreated,
    totalSettled,
    totalAutoReleased,
    totalResolved,
    totalPaidCredits,
    totalAdminAssignedCredits,
    totalAdminRemovedCredits,
    totalIncomingCredits,
    totalLegacyCurrentDebt,
    totalHistoricalOverResolved,
    totalActiveDebtMarkers: sumMapValues(activeDebtMarkersByService),
    createdByService,
    settledByService,
    autoReleasedByService,
    expectedDebtByService,
    activeDebtMarkersByService,
    legacyCurrentDebtByService,
    historicalOverResolvedByService,
    unexplainedGeneratedByService,
    autoReleaseNoticeCount,
    reconciliationStatus: rowStatus.reconciliationStatus,
    reconciliationLabel: rowStatus.reconciliationLabel,
    reconciliationTone: rowStatus.reconciliationTone,
    reconciliationMessage: rowStatus.reconciliationMessage,
    needsManualReview: rowStatus.needsManualReview,
    unexplainedDelta,
    lastEventAt,
    hasDebtContext,
    events: displayEvents,
  };
}

function translateMembershipTier(tier) {
  const v = String(tier || "").toLowerCase().trim();
  if (!v) return "";
  if (v === "plus") return "Membresía Plus";
  return `Membresía ${v.charAt(0).toUpperCase()}${v.slice(1)}`;
}

function extractServiceNameFromOrder(order) {
  if (!order) return "";

  // 1) Checkout moderno: items[]
  if (Array.isArray(order.items) && order.items.length > 0) {
    const first = order.items[0] || {};

    const label = String(first.label || "").trim();
    if (label) return label;

    const kind = String(first.kind || "").toUpperCase().trim();

    if (kind === "CREDITS") {
      const byKey = translateServiceKey(first.serviceKey);
      if (byKey) {
        const credits = Number(first.credits || 0);
        return credits > 0 ? `${byKey} (${credits} créditos)` : byKey;
      }
    }

    if (kind === "MEMBERSHIP") {
      const tier = translateMembershipTier(first.membershipTier);
      if (tier) return tier;
    }

    const fallbackCandidates = [
      first.serviceName,
      first.service,
      first.planName,
      first.name,
      first.title,
      first.productName,
      first.description,
    ];

    for (const candidate of fallbackCandidates) {
      const text = String(candidate || "").trim();
      if (text) return text;
    }
  }

  // 2) Legacy
  const legacyLabel = String(order.label || "").trim();
  if (legacyLabel) return legacyLabel;

  const legacyService = translateServiceKey(order.serviceKey);
  if (legacyService) {
    const credits = Number(order.credits || 0);
    return credits > 0 ? `${legacyService} (${credits} créditos)` : legacyService;
  }

  // 3) Fallbacks varios
  const directCandidates = [
    order.serviceName,
    order.service,
    order.planName,
    order.title,
    order.itemName,
    order.productName,
  ];

  for (const candidate of directCandidates) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }

  return "";
}

async function buildLastPaidOrder(from, to) {
  const order = await Order.findOne({
    ...buildDateMatch("createdAt", from, to),
    status: { $in: ["paid", "approved"] },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!order) return null;

  let subjectName = "";

  if (order.user) {
    try {
      const targetUser = await User.findById(order.user)
        .select("name lastName fullName")
        .lean();

      subjectName = fullNameOf(targetUser);
    } catch {
      // noop
    }
  }

  if (!subjectName) {
    const directName =
      String(order.userFullName || "").trim() ||
      String(order.customerName || "").trim() ||
      String(order.clientName || "").trim() ||
      String(order.fullName || "").trim();

    if (directName) subjectName = directName;
  }

  let actorName = "";

  // Intento desde activity log
  try {
    const log = await ActivityLog.findOne({
      entity: { $in: ["order", "orders"] },
      entityId: String(order._id),
      action: { $in: ["order_created", "order_paid"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    actorName =
      String(log?.actor?.fullName || "").trim() ||
      String(log?.actor?.name || "").trim();
  } catch {
    // noop
  }

  const serviceName = extractServiceNameFromOrder(order);

  return {
    id: String(order._id),
    actorName: actorName || "",
    subjectName: subjectName || "",
    serviceName: serviceName || "",
    total: pickOrderTotal(order),
    createdAt: order.createdAt || null,
    status: order.status || "",
  };
}

router.get("/summary", async (req, res) => {
  try {
    const { from, to, preset } = resolveRange(req.query || {});

    const [
      orders,
      reservedCount,
      cancelledCount,
      completedCount,
      usersCreatedCount,
      evaluationsCreatedCount,
      activityBreakdown,
      deletedEvaluations,
      creditMutations,
      lastPaidOrder,
    ] = await Promise.all([
      Order.find(buildDateMatch("createdAt", from, to)).lean(),

      Appointment.countDocuments({
        ...buildDateMatch("createdAt", from, to),
        status: "reserved",
      }),

      Appointment.countDocuments({
        ...buildDateMatch("createdAt", from, to),
        status: "cancelled",
      }),

      Appointment.countDocuments({
        status: "reserved",
        $expr: {
          $and: [
            {
              $gte: [
                {
                  $dateFromString: {
                    dateString: { $concat: ["$date", "T", "$time", ":00"] },
                    onError: null,
                    onNull: null,
                  },
                },
                from,
              ],
            },
            {
              $lte: [
                {
                  $dateFromString: {
                    dateString: { $concat: ["$date", "T", "$time", ":00"] },
                    onError: null,
                    onNull: null,
                  },
                },
                to,
              ],
            },
            {
              $lt: [
                {
                  $dateFromString: {
                    dateString: { $concat: ["$date", "T", "$time", ":00"] },
                    onError: null,
                    onNull: null,
                  },
                },
                new Date(),
              ],
            },
          ],
        },
      }),

      User.countDocuments(buildDateMatch("createdAt", from, to)),

      Evaluation.countDocuments(buildDateMatch("createdAt", from, to)),

      ActivityLog.aggregate([
        { $match: buildDateMatch("createdAt", from, to) },
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ]),

      ActivityLog.countDocuments({
        ...buildDateMatch("createdAt", from, to),
        category: "evaluations",
        action: "evaluation_deleted",
      }),

      ActivityLog.countDocuments({
        ...buildDateMatch("createdAt", from, to),
        category: "users",
        action: { $in: ["credits_updated", "credit_updated"] },
      }),

      buildLastPaidOrder(from, to),
    ]);

    const cards = {
      ordersCount: orders.length,
      ordersPaidCount: orders.filter((o) => isPaidOrderStatus(o.status)).length,
      ordersPendingCount: orders.filter((o) => isPendingOrderStatus(o.status)).length,
      ordersCancelledCount: orders.filter(
        (o) => normalizeOrderStatus(o.status) === "cancelled"
      ).length,

      ordersTotalAll: orders.reduce((acc, o) => acc + pickOrderTotal(o), 0),

      ordersTotalPaid: orders
        .filter((o) => isPaidOrderStatus(o.status))
        .reduce((acc, o) => acc + pickOrderTotal(o), 0),

      ordersTotalPending: orders
        .filter((o) => isPendingOrderStatus(o.status))
        .reduce((acc, o) => acc + pickOrderTotal(o), 0),

      appointmentsReservedCount: Number(reservedCount || 0),
      appointmentsCancelledCount: Number(cancelledCount || 0),
      appointmentsCompletedCount: Number(completedCount || 0),

      usersCreatedCount: Number(usersCreatedCount || 0),
      evaluationsCreatedCount: Number(evaluationsCreatedCount || 0),
      evaluationsDeletedCount: Number(deletedEvaluations || 0),
      creditMutationsCount: Number(creditMutations || 0),
    };

    return res.json({
      ok: true,
      range: { preset, from, to },
      cards,
      activityBreakdown: activityBreakdown || [],
      lastPaidOrder: lastPaidOrder || null,
    });
  } catch (err) {
    console.error("GET /admin/dashboard/summary error:", err);
    return res.status(500).json({
      ok: false,
      error: "No se pudo cargar el resumen.",
    });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const { from, to, preset } = resolveRange(req.query || {});
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;

    const match = buildActivityFilters(req.query || {}, from, to);

    const [items, total] = await Promise.all([
      ActivityLog.find(match)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ActivityLog.countDocuments(match),
    ]);

    return res.json({
      ok: true,
      range: { preset, from, to },
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      items,
    });
  } catch (err) {
    console.error("GET /admin/dashboard/activity error:", err);
    return res.status(500).json({
      ok: false,
      error: "No se pudo cargar la actividad.",
    });
  }
});

router.get("/debt-history", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 80)));
    const search = String(req.query.search || "").trim();

    const debtActionList = [...DEBT_HISTORY_ACTIONS];
    const excludedObjectIds = [...EXCLUDED_DEBT_USER_IDS]
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const appointmentDebtMatch = {
      fixedScheduleId: { $ne: null },
      status: { $in: ["reserved", "completed"] },
      $or: [
        { creditDebitStatus: "debt" },
        { fixedDebtAmount: { $gt: 0 } },
      ],
    };

    const debtAppointmentSeed = await Appointment.find(appointmentDebtMatch)
      .select(
        "_id user date time service serviceName serviceKey status fixedScheduleId creditDebitStatus fixedDebtAmount refundReason createdAt updatedAt"
      )
      .sort({ date: -1, time: -1, createdAt: -1 })
      .limit(1000)
      .lean();

    const appointmentUserIds = [
      ...new Set(
        debtAppointmentSeed
          .map((ap) => String(ap.user || ""))
          .filter((id) => mongoose.Types.ObjectId.isValid(id) && !EXCLUDED_DEBT_USER_IDS.has(id))
      ),
    ];

    const query = {
      $and: [
        excludedObjectIds.length ? { _id: { $nin: excludedObjectIds } } : {},
        { email: { $not: /^admin@duoclub\.ar$/i } },
      ].filter((part) => Object.keys(part).length > 0),
      $or: [
        ...DEBT_SERVICE_KEYS.map((sk) => ({
          [`fixedScheduleDebt.${sk}`]: { $gt: 0 },
        })),
        { "history.action": { $in: debtActionList } },
        ...(appointmentUserIds.length
          ? [{ _id: { $in: appointmentUserIds } }]
          : []),
      ],
    };

    if (search) {
      query.$and = [
        ...(Array.isArray(query.$and) ? query.$and : []),
        {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { lastName: { $regex: search, $options: "i" } },
            { fullName: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { phone: { $regex: search, $options: "i" } },
          ],
        },
      ];
    }

    const users = (await User.find(query)
      .select("name lastName fullName email phone role fixedScheduleDebt history createdAt updatedAt")
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean()).filter((user) => !isExcludedDebtUser(user));

    const userIdSet = new Set(users.map((u) => String(u._id || "")));
    const debtAppointments = debtAppointmentSeed.filter((ap) =>
      userIdSet.has(String(ap.user || ""))
    );

    const [paidCreditOrders, manualCreditLogs] = await Promise.all([
      Order.find({
        user: { $in: [...userIdSet].map((id) => new mongoose.Types.ObjectId(id)) },
        status: { $regex: "^(paid|approved)$", $options: "i" },
      })
        .select(
          "_id user items service serviceName serviceKey credits total totalFinal status paidAt approvedAt createdAt updatedAt"
        )
        .sort({ paidAt: -1, approvedAt: -1, updatedAt: -1, createdAt: -1 })
        .limit(2000)
        .lean(),

      ActivityLog.find({
        category: "users",
        action: { $in: ["credits_updated", "credit_updated"] },
        entity: { $in: ["user", "users"] },
        $or: [
          { entityId: { $in: [...userIdSet] } },
          { "subject.id": { $in: [...userIdSet] } },
          { "subject._id": { $in: [...userIdSet] } },
        ],
      })
        .select("_id actor entity entityId subject title description diff meta createdAt")
        .sort({ createdAt: -1 })
        .limit(5000)
        .lean(),
    ]);

    const appointmentsByUser = new Map();
    for (const ap of debtAppointments) {
      const key = String(ap.user || "");
      if (!appointmentsByUser.has(key)) appointmentsByUser.set(key, []);
      appointmentsByUser.get(key).push(ap);
    }

    const paidCreditOrdersByUser = new Map();
    for (const order of paidCreditOrders) {
      const key = String(order.user || "");
      if (!paidCreditOrdersByUser.has(key)) paidCreditOrdersByUser.set(key, []);
      paidCreditOrdersByUser.get(key).push(order);
    }

    const manualCreditLogsByUser = new Map();
    for (const log of manualCreditLogs) {
      const key = String(log.entityId || log.subject?.id || log.subject?._id || "");
      if (!manualCreditLogsByUser.has(key)) manualCreditLogsByUser.set(key, []);
      manualCreditLogsByUser.get(key).push(log);
    }

    const rows = users
      .map((user) =>
        decorateDebtUser(
          user,
          (appointmentsByUser.get(String(user._id || "")) || []).map(
            (ap, index) => debtEventFromAppointment(ap, index)
          ),
          (paidCreditOrdersByUser.get(String(user._id || "")) || []).flatMap(
            (order) => extractPaidCreditEventsFromOrder(order)
          ),
          (manualCreditLogsByUser.get(String(user._id || "")) || []).flatMap(
            (log) => extractManualCreditEventsFromLog(log)
          )
        )
      )
      .filter((row) => row.hasDebtContext)
      .sort((a, b) => {
        if (b.currentDebt !== a.currentDebt) return b.currentDebt - a.currentDebt;
        if (Number(b.needsManualReview) !== Number(a.needsManualReview)) {
          return Number(b.needsManualReview) - Number(a.needsManualReview);
        }
        const ad = a.lastEventAt ? new Date(a.lastEventAt).getTime() : 0;
        const bd = b.lastEventAt ? new Date(b.lastEventAt).getTime() : 0;
        return bd - ad;
      });

    const totals = rows.reduce(
      (acc, row) => {
        acc.usersCount += 1;
        acc.currentDebt += Number(row.currentDebt || 0);
        acc.currentDebtExigible += Number(row.currentDebtExigible || row.currentDebt || 0);
        acc.totalCreated += Number(row.totalCreated || 0);
        acc.totalSettled += Number(row.totalSettled || 0);
        acc.totalAutoReleased += Number(row.totalAutoReleased || 0);
        acc.totalResolved += Number(row.totalResolved || 0);
        acc.totalPaidCredits += Number(row.totalPaidCredits || 0);
        acc.totalAdminAssignedCredits += Number(row.totalAdminAssignedCredits || 0);
        acc.totalAdminRemovedCredits += Number(row.totalAdminRemovedCredits || 0);
        acc.totalIncomingCredits += Number(row.totalIncomingCredits || 0);
        acc.totalLegacyCurrentDebt += Number(row.totalLegacyCurrentDebt || 0);
        acc.totalHistoricalOverResolved += Number(row.totalHistoricalOverResolved || 0);
        acc.totalActiveDebtMarkers += Number(row.totalActiveDebtMarkers || 0);
        acc.unexplainedDelta += Number(row.unexplainedDelta || 0);

        if (row.needsManualReview) acc.reviewCount += 1;
        if (row.reconciliationStatus === "legacy_debt") acc.legacyDebtCount += 1;
        if (row.reconciliationStatus === "historical_over_resolved") acc.historicalOnlyCount += 1;
        if (row.reconciliationStatus === "auto_released") acc.autoReleasedUsersCount += 1;
        if (row.currentDebt > 0) acc.usersWithCurrentDebt += 1;
        return acc;
      },
      {
        usersCount: 0,
        currentDebt: 0,
        currentDebtExigible: 0,
        totalCreated: 0,
        totalSettled: 0,
        totalAutoReleased: 0,
        totalResolved: 0,
        totalPaidCredits: 0,
        totalAdminAssignedCredits: 0,
        totalAdminRemovedCredits: 0,
        totalIncomingCredits: 0,
        totalLegacyCurrentDebt: 0,
        totalHistoricalOverResolved: 0,
        totalActiveDebtMarkers: 0,
        unexplainedDelta: 0,
        reviewCount: 0,
        legacyDebtCount: 0,
        historicalOnlyCount: 0,
        autoReleasedUsersCount: 0,
        usersWithCurrentDebt: 0,
      }
    );

    return res.json({
      ok: true,
      historyScopeLabel: "Deuda real separada de historial legacy",
      limit,
      total: rows.length,
      totals,
      users: rows,
    });
  } catch (err) {
    console.error("GET /admin/dashboard/debt-history error:", err);
    return res.status(500).json({
      ok: false,
      error: "No se pudo cargar el historial de deuda.",
    });
  }
});

export default router;
