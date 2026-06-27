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

const DEBT_HISTORY_ACTIONS = new Set([
  "fixed_schedule_monthly_debt",
  "fixed_schedule_debt_settled",
  "fixed_schedule_debt_settled_by_cancelled_credit",
  "fixed_schedule_debt_settled_by_plan_delete",
  "fixed_schedule_debt_released_by_cancel",
  "fixed_schedule_debt_released_by_plan_delete",
  "credits_added_monthly",
]);

function normalizeServiceKey(serviceKey) {
  const key = String(serviceKey || "").toUpperCase().trim();
  if (!key) return "";
  if (key === "AR") return "RA";
  return SERVICE_KEY_TO_NAME[key] ? key : "";
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

function classifyDebtHistoryItem(item = {}) {
  const action = String(item.action || "").trim();

  if (action === "fixed_schedule_monthly_debt") {
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

  if (action === "credits_added_monthly") {
    return {
      type: "credits_loaded",
      label: "Créditos cargados",
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
  const qty = Math.max(0, Number(item.qty || item.amount || item.value || 0));
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
    type: "debt_appointment",
    label: "Turno fijo con deuda",
    sign: Number(ap.fixedDebtAmount || 0) > 0 ? 1 : 0,
    serviceKey,
    serviceName: translateServiceKey(serviceKey) || ap.serviceName || ap.service || "",
    qty,
    date: ap.date || "",
    time: ap.time || "",
    title: "Turno fijo marcado con deuda",
    message: "Registro tomado desde la reserva asociada al turno fijo.",
    appointmentId: ap._id || null,
    fixedScheduleId: ap.fixedScheduleId || null,
    createdAt: ap.updatedAt || ap.createdAt || null,
  };
}

function decorateDebtUser(user = {}, appointmentEvents = []) {
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

  const events = [...historyEvents, ...safeAppointmentEvents]
    .filter((event) => event.serviceKey || event.type === "credits_loaded")
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

  const totalCreditsLoaded = events
    .filter((event) => event.type === "credits_loaded")
    .reduce((acc, event) => acc + Number(event.qty || 0), 0);

  const lastEventAt = events[0]?.createdAt || null;

  return {
    id: String(user._id || ""),
    fullName: fullNameOf(user) || "Usuario",
    email: user.email || "",
    phone: user.phone || "",
    currentDebt,
    currentDebtByService,
    totalCreated,
    totalSettled,
    totalCreditsLoaded,
    lastEventAt,
    events,
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
    const appointmentDebtMatch = {
      fixedScheduleId: { $ne: null },
      $or: [
        { creditDebitStatus: "debt" },
        { fixedDebtAmount: { $gt: 0 } },
        { refundReason: { $regex: "DEBT", $options: "i" } },
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
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      ),
    ];

    const query = {
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

    const users = await User.find(query)
      .select("name lastName fullName email phone fixedScheduleDebt history createdAt")
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    const userIdSet = new Set(users.map((u) => String(u._id || "")));
    const debtAppointments = debtAppointmentSeed.filter((ap) =>
      userIdSet.has(String(ap.user || ""))
    );

    const appointmentsByUser = new Map();
    for (const ap of debtAppointments) {
      const key = String(ap.user || "");
      if (!appointmentsByUser.has(key)) appointmentsByUser.set(key, []);
      appointmentsByUser.get(key).push(ap);
    }

    const rows = users
      .map((user) =>
        decorateDebtUser(
          user,
          (appointmentsByUser.get(String(user._id || "")) || []).map(
            (ap, index) => debtEventFromAppointment(ap, index)
          )
        )
      )
      .filter((row) => row.currentDebt > 0 || row.events.length > 0)
      .sort((a, b) => {
        if (b.currentDebt !== a.currentDebt) return b.currentDebt - a.currentDebt;
        const ad = a.lastEventAt ? new Date(a.lastEventAt).getTime() : 0;
        const bd = b.lastEventAt ? new Date(b.lastEventAt).getTime() : 0;
        return bd - ad;
      });

    const totals = rows.reduce(
      (acc, row) => {
        acc.usersCount += 1;
        acc.currentDebt += Number(row.currentDebt || 0);
        acc.totalCreated += Number(row.totalCreated || 0);
        acc.totalSettled += Number(row.totalSettled || 0);
        acc.totalCreditsLoaded += Number(row.totalCreditsLoaded || 0);
        return acc;
      },
      {
        usersCount: 0,
        currentDebt: 0,
        totalCreated: 0,
        totalSettled: 0,
        totalCreditsLoaded: 0,
      }
    );

    return res.json({
      ok: true,
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
