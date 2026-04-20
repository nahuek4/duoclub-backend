import express from "express";

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
  NUT: "Nutrición",
};

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

export default router;