// scripts/auditPlanCoverageHistory.js
// SOLO LECTURA.
// Audita que Planes, diferencias de turnos fijos y órdenes queden trazables.
// No crea, actualiza ni elimina documentos.

import "dotenv/config";
import mongoose from "mongoose";

import Appointment from "../src/models/Appointment.js";
import Order from "../src/models/Order.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionExtraSessionNotice from "../src/models/SubscriptionExtraSessionNotice.js";

function clean(value) {
  return String(value ?? "").trim();
}

function asInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function oid(value) {
  const id = clean(value?._id || value?.id || value);
  return mongoose.Types.ObjectId.isValid(id) ? id : "";
}

function currentMonthKeyArgentina(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : "";
}

function monthRange(periodKey) {
  const [year, month] = clean(periodKey).split("-").map(Number);
  if (!year || !month) return { start: "", end: "" };
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${String(month).padStart(2, "0")}-01`,
    end: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

function orderKinds(order = {}) {
  return new Set(
    (Array.isArray(order?.items) ? order.items : [])
      .map((item) => clean(item?.kind).toUpperCase())
      .filter(Boolean)
  );
}

function paidStatus(value) {
  return ["paid", "approved"].includes(clean(value).toLowerCase());
}

function sessionsForNoticeFromOrder(order, noticeId) {
  const target = oid(noticeId);
  if (!target) return 0;

  return (Array.isArray(order?.items) ? order.items : [])
    .filter(
      (item) =>
        clean(item?.kind).toUpperCase() === "SUBSCRIPTION_EXTRA" &&
        oid(item?.extraSessionNotice) === target
    )
    .reduce(
      (sum, item) =>
        sum + asInt(item?.credits) * Math.max(1, asInt(item?.qty) || 1),
      0
    );
}

const uri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URL ||
  process.env.DATABASE_URL ||
  process.env.MONGO;

if (!uri) {
  throw new Error("No encontré MONGO_URI/MONGODB_URI/MONGO_URL/MONGODB_URL/DATABASE_URL/MONGO.");
}

const details = process.argv.includes("--details");
const currentPeriodKey = currentMonthKeyArgentina();
const currentRange = monthRange(currentPeriodKey);

await mongoose.connect(uri);

try {
  const [subscriptions, notices, extraOrders] = await Promise.all([
    ServiceSubscription.find({})
      .select(
        "user serviceKey monthlySessions status currentPeriodKey bootstrap createdAt updatedAt"
      )
      .populate("user", "name lastName fullName email")
      .lean(),
    SubscriptionExtraSessionNotice.find({})
      .sort({ periodKey: 1, serviceKey: 1 })
      .lean(),
    Order.find({ "items.kind": "SUBSCRIPTION_EXTRA" })
      .select("_id user status payMethod total totalFinal paidAt createdAt items subscriptionExtraApplied")
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const subscriptionById = new Map(
    subscriptions.map((subscription) => [String(subscription._id), subscription])
  );
  const noticeById = new Map(notices.map((notice) => [String(notice._id), notice]));
  const paidExtraOrdersByNotice = new Map();
  const allOrderIds = new Set();

  for (const order of extraOrders) {
    const id = oid(order);
    if (id) allOrderIds.add(id);
    for (const item of Array.isArray(order?.items) ? order.items : []) {
      if (clean(item?.kind).toUpperCase() !== "SUBSCRIPTION_EXTRA") continue;
      const noticeId = oid(item?.extraSessionNotice);
      if (!noticeId) continue;
      const list = paidExtraOrdersByNotice.get(noticeId) || [];
      list.push(order);
      paidExtraOrdersByNotice.set(noticeId, list);
    }
  }

  for (const notice of notices) {
    for (const value of [
      notice?.pendingOrder,
      notice?.lastPaidOrder,
      ...(Array.isArray(notice?.purchasedOrderIds) ? notice.purchasedOrderIds : []),
    ]) {
      const id = oid(value);
      if (id) allOrderIds.add(id);
    }
  }

  for (const subscription of subscriptions) {
    const id = oid(subscription?.bootstrap?.latestPaidOrder?.orderId);
    if (id) allOrderIds.add(id);
  }

  const linkedOrders = allOrderIds.size
    ? await Order.find({
        _id: {
          $in: [...allOrderIds].map((id) => new mongoose.Types.ObjectId(id)),
        },
      })
        .select("_id status payMethod total totalFinal paidAt createdAt items subscriptionExtraApplied subscriptionCycleApplied")
        .lean()
    : [];
  const linkedOrderById = new Map(
    linkedOrders.map((order) => [String(order._id), order])
  );

  const currentCounts = await Appointment.aggregate([
    {
      $match: {
        fixedScheduleId: { $ne: null },
        status: { $in: ["reserved", "completed"] },
        date: { $gte: currentRange.start, $lte: currentRange.end },
      },
    },
    {
      $group: {
        _id: { user: "$user", serviceKey: "$serviceKey" },
        count: { $sum: 1 },
      },
    },
  ]);
  const currentCountByPair = new Map(
    currentCounts.map((row) => [
      `${String(row?._id?.user || "")}:${clean(row?._id?.serviceKey).toUpperCase()}`,
      asInt(row?.count),
    ])
  );

  const rows = [];
  const issues = [];

  function pushIssue(type, severity, context = {}) {
    issues.push({ type, severity, ...context });
  }

  for (const notice of notices) {
    const subscription = subscriptionById.get(String(notice.subscription));
    const user = subscription?.user || {};
    const userId = oid(notice.user || subscription?.user?._id || subscription?.user);
    const serviceKey = clean(notice.serviceKey || subscription?.serviceKey).toUpperCase();
    const periodKey = clean(notice.periodKey);
    const currentRequired = asInt(notice.extraSessionsRequired);
    const purchased = asInt(notice.extraSessionsPurchased);
    const historicalRequired = Math.max(
      currentRequired,
      asInt(notice.historicalExtraSessionsRequired)
    );
    const remaining = Math.max(0, currentRequired - purchased);
    const purchasedIds = new Set(
      [
        ...(Array.isArray(notice.purchasedOrderIds) ? notice.purchasedOrderIds : []),
        notice.lastPaidOrder,
      ]
        .map(oid)
        .filter(Boolean)
    );
    const paidLinked = [...purchasedIds]
      .map((id) => linkedOrderById.get(id))
      .filter((order) => order && paidStatus(order.status));

    rows.push({
      user: clean(user?.fullName) || [clean(user?.name), clean(user?.lastName)].filter(Boolean).join(" ") || clean(user?.email) || userId,
      email: clean(user?.email),
      service: serviceKey,
      period: periodKey,
      plan: asInt(notice.basePlanSessions || subscription?.monthlySessions),
      fixedCurrent: asInt(notice.projectedFixedOccurrences),
      diffCurrent: currentRequired,
      diffHistory: historicalRequired,
      purchased,
      pending: remaining,
      orders: paidLinked.map((order) => String(order._id)).join(","),
      source: clean(notice.source),
    });

    if (historicalRequired < currentRequired) {
      pushIssue("HISTORY_LT_CURRENT", "REVIEW", {
        userId,
        serviceKey,
        periodKey,
        currentRequired,
        historicalRequired,
      });
    }

    if (purchased > 0 && paidLinked.length === 0) {
      pushIssue("PURCHASED_WITHOUT_PAID_ORDER_LINK", "REVIEW", {
        userId,
        serviceKey,
        periodKey,
        purchased,
        purchasedOrderIds: [...purchasedIds],
      });
    }

    const linkedPurchasedSessions = paidLinked.reduce(
      (sum, order) => sum + sessionsForNoticeFromOrder(order, notice._id),
      0
    );
    if (purchased > 0 && linkedPurchasedSessions !== purchased) {
      pushIssue("PURCHASED_SESSIONS_ORDER_MISMATCH", "REVIEW", {
        userId,
        serviceKey,
        periodKey,
        purchased,
        linkedPurchasedSessions,
        purchasedOrderIds: [...purchasedIds],
      });
    }

    const pendingOrderId = oid(notice?.pendingOrder);
    if (pendingOrderId) {
      const pendingOrder = linkedOrderById.get(pendingOrderId);
      const pendingStatus = clean(pendingOrder?.status).toLowerCase();
      if (!pendingOrder) {
        pushIssue("PENDING_ORDER_MISSING", "REVIEW", {
          userId,
          serviceKey,
          periodKey,
          orderId: pendingOrderId,
        });
      } else if (!["pending"].includes(pendingStatus)) {
        pushIssue("PENDING_ORDER_STATUS_STALE", "REVIEW", {
          userId,
          serviceKey,
          periodKey,
          orderId: pendingOrderId,
          pendingStatus,
        });
      }
    }

    if (periodKey === currentPeriodKey && subscription) {
      const actualFixed = currentCountByPair.get(`${userId}:${serviceKey}`) || 0;
      const plan = Math.max(1, asInt(subscription.monthlySessions));
      const expectedRequired = Math.max(0, actualFixed - plan);
      if (expectedRequired !== currentRequired) {
        pushIssue("CURRENT_NOTICE_NEEDS_REFRESH", "REVIEW", {
          userId,
          serviceKey,
          periodKey,
          actualFixed,
          plan,
          expectedRequired,
          noticeRequired: currentRequired,
        });
      }
    }
  }

  for (const subscription of subscriptions) {
    const bootstrap = subscription?.bootstrap || {};
    const required = asInt(bootstrap?.extraSessionsRequired);
    const periodKey = clean(bootstrap?.monthKey);
    if (!required || !periodKey) continue;

    const matchingNotice = notices.find(
      (notice) =>
        String(notice.subscription) === String(subscription._id) &&
        clean(notice.periodKey) === periodKey
    );
    if (matchingNotice) continue;

    const basePlan = Math.max(1, asInt(bootstrap?.basePlanSessions || subscription?.monthlySessions));
    const paidCredits = asInt(
      bootstrap?.paidCredits || bootstrap?.latestPaidOrder?.sessions
    );
    const inferredPaid = Math.min(required, Math.max(0, paidCredits - basePlan));
    const bootstrapOrderId = oid(bootstrap?.latestPaidOrder?.orderId);

    pushIssue("BOOTSTRAP_HISTORY_WITHOUT_NOTICE", "INFO", {
      subscriptionId: String(subscription._id),
      userId: oid(subscription?.user?._id || subscription?.user),
      email: clean(subscription?.user?.email),
      serviceKey: clean(subscription?.serviceKey),
      periodKey,
      required,
      inferredPaid,
      orderId: inferredPaid > 0 ? bootstrapOrderId : "",
    });

    if (inferredPaid > 0 && (!bootstrapOrderId || !linkedOrderById.get(bootstrapOrderId))) {
      pushIssue("BOOTSTRAP_INFERRED_PAYMENT_ORDER_MISSING", "REVIEW", {
        subscriptionId: String(subscription._id),
        serviceKey: clean(subscription?.serviceKey),
        periodKey,
        required,
        inferredPaid,
        orderId: bootstrapOrderId,
      });
    } else if (inferredPaid > 0) {
      const bootstrapOrder = linkedOrderById.get(bootstrapOrderId);
      if (!paidStatus(bootstrapOrder?.status)) {
        pushIssue("BOOTSTRAP_INFERRED_PAYMENT_ORDER_NOT_PAID", "REVIEW", {
          subscriptionId: String(subscription._id),
          serviceKey: clean(subscription?.serviceKey),
          periodKey,
          required,
          inferredPaid,
          orderId: bootstrapOrderId,
          status: clean(bootstrapOrder?.status),
        });
      }
    }
  }

  for (const order of extraOrders) {
    const kinds = orderKinds(order);
    if (!kinds.has("SUBSCRIPTION_EXTRA") || !paidStatus(order.status)) continue;

    for (const item of Array.isArray(order.items) ? order.items : []) {
      if (clean(item?.kind).toUpperCase() !== "SUBSCRIPTION_EXTRA") continue;
      const noticeId = oid(item.extraSessionNotice);
      if (!noticeId || !noticeById.has(noticeId)) {
        pushIssue("PAID_EXTRA_ORDER_WITHOUT_NOTICE", "REVIEW", {
          orderId: String(order._id),
          userId: oid(order.user),
          serviceKey: clean(item?.serviceKey),
          periodKey: clean(item?.periodKey),
          noticeId,
        });
      }
    }
  }

  const severityCounts = issues.reduce(
    (acc, issue) => {
      acc[issue.severity] = (acc[issue.severity] || 0) + 1;
      return acc;
    },
    {}
  );
  const typeCounts = issues.reduce(
    (acc, issue) => {
      acc[issue.type] = (acc[issue.type] || 0) + 1;
      return acc;
    },
    {}
  );

  console.log("\nAUDITORÍA PLANES + DIFERENCIAS + ÓRDENES (SOLO LECTURA)\n");
  console.log({
    currentPeriodKey,
    subscriptions: subscriptions.length,
    notices: notices.length,
    extraOrders: extraOrders.length,
    historyRows: rows.length,
    issues: issues.length,
    severityCounts,
    typeCounts,
  });

  if (details && rows.length) {
    console.log("\nHISTORIAL CONSOLIDADO\n");
    console.table(rows);
  }

  if (issues.length) {
    console.log("\nHALLAZGOS\n");
    console.table(
      issues.map((issue) => ({
        severity: issue.severity,
        type: issue.type,
        email: issue.email || "",
        userId: issue.userId || "",
        service: issue.serviceKey || "",
        period: issue.periodKey || "",
        orderId: issue.orderId || "",
        detail: JSON.stringify(
          Object.fromEntries(
            Object.entries(issue).filter(
              ([key]) => !["severity", "type", "email", "userId", "serviceKey", "periodKey", "orderId"].includes(key)
            )
          )
        ),
      }))
    );
  } else {
    console.log("\nOK: no se detectaron inconsistencias de trazabilidad.\n");
  }

  const reviewCount = issues.filter((issue) => issue.severity === "REVIEW").length;
  console.log(
    reviewCount
      ? `\nRESULTADO: ${reviewCount} hallazgo(s) para revisar. NO SE MODIFICÓ NINGÚN DATO.`
      : "\nRESULTADO: auditoría consistente. NO SE MODIFICÓ NINGÚN DATO."
  );
} finally {
  await mongoose.disconnect();
}
