// scripts/auditPlanCoverageHistory.js
// SOLO LECTURA.
// Audita Planes + diferencias + órdenes sin modificar documentos.

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Appointment from "../src/models/Appointment.js";
import Order from "../src/models/Order.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
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

function paidStatus(value) {
  return ["paid", "approved"].includes(clean(value).toLowerCase());
}

function orderKinds(order = {}) {
  return Array.from(
    new Set(
      (Array.isArray(order?.items) ? order.items : [])
        .map((item) => clean(item?.kind).toUpperCase())
        .filter(Boolean)
    )
  );
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

function userLabel(user, fallback = "") {
  return (
    clean(user?.fullName) ||
    [clean(user?.name), clean(user?.lastName)].filter(Boolean).join(" ") ||
    clean(user?.email) ||
    fallback
  );
}

function pairKey(userId, serviceKey) {
  return `${clean(userId)}:${clean(serviceKey).toUpperCase()}`;
}

function periodPairKey(userId, serviceKey, periodKey) {
  return `${pairKey(userId, serviceKey)}:${clean(periodKey)}`;
}

function statusPriority(status) {
  const s = clean(status).toLowerCase();
  if (s === "active") return 5;
  if (s === "pending_change") return 4;
  if (s === "suspended") return 3;
  if (s === "cancelled") return 2;
  if (s === "terminated_for_non_payment") return 1;
  return 0;
}

const uri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URL ||
  process.env.DATABASE_URL ||
  process.env.MONGO;

if (!uri) {
  throw new Error(
    "No encontré MONGO_URI/MONGODB_URI/MONGO_URL/MONGODB_URL/DATABASE_URL/MONGO."
  );
}

const details = process.argv.includes("--details");
const currentPeriodKey = currentMonthKeyArgentina();
const currentRange = monthRange(currentPeriodKey);

await mongoose.connect(uri);

try {
  const [subscriptions, notices, cycles, explicitExtraOrders] = await Promise.all([
    ServiceSubscription.find({})
      .select(
        "user serviceKey monthlySessions status currentPeriodKey bootstrap createdAt updatedAt"
      )
      .populate("user", "name lastName fullName email")
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean(),
    SubscriptionExtraSessionNotice.find({})
      .sort({ periodKey: 1, serviceKey: 1 })
      .lean(),
    SubscriptionBillingCycle.find({ periodKey: currentPeriodKey })
      .select("subscription user serviceKey periodKey planSnapshot billing lifecycle")
      .lean(),
    Order.find({ "items.kind": "SUBSCRIPTION_EXTRA" })
      .select(
        "_id user status payMethod total totalFinal paidAt approvedAt createdAt items subscriptionExtraApplied"
      )
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const subscriptionById = new Map(
    subscriptions.map((subscription) => [String(subscription._id), subscription])
  );
  const subscriptionsByPair = new Map();
  for (const subscription of subscriptions) {
    const userId = oid(subscription?.user?._id || subscription?.user);
    const serviceKey = clean(subscription?.serviceKey).toUpperCase();
    if (!userId || !serviceKey) continue;
    const key = pairKey(userId, serviceKey);
    const list = subscriptionsByPair.get(key) || [];
    list.push(subscription);
    subscriptionsByPair.set(key, list);
  }
  for (const [key, list] of subscriptionsByPair) {
    list.sort((a, b) => {
      const currentA = clean(a?.currentPeriodKey) === currentPeriodKey ? 1 : 0;
      const currentB = clean(b?.currentPeriodKey) === currentPeriodKey ? 1 : 0;
      if (currentA !== currentB) return currentB - currentA;
      const pri = statusPriority(b?.status) - statusPriority(a?.status);
      if (pri) return pri;
      return new Date(b?.updatedAt || b?.createdAt || 0) - new Date(a?.updatedAt || a?.createdAt || 0);
    });
  }

  const cycleBySubscription = new Map(
    cycles.map((cycle) => [String(cycle.subscription), cycle])
  );
  const noticeById = new Map(notices.map((notice) => [String(notice._id), notice]));
  const noticeByPairPeriod = new Map();
  for (const notice of notices) {
    noticeByPairPeriod.set(
      periodPairKey(notice.user, notice.serviceKey, notice.periodKey),
      notice
    );
  }

  const allOrderIds = new Set();
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
  for (const order of explicitExtraOrders) {
    const id = oid(order);
    if (id) allOrderIds.add(id);
  }

  const linkedOrders = allOrderIds.size
    ? await Order.find({
        _id: {
          $in: [...allOrderIds].map((id) => new mongoose.Types.ObjectId(id)),
        },
      })
        .select(
          "_id user status payMethod total totalFinal paidAt approvedAt createdAt items subscriptionExtraApplied subscriptionCycleApplied credits serviceKey service serviceName"
        )
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
      pairKey(row?._id?.user, row?._id?.serviceKey),
      asInt(row?.count),
    ])
  );

  const rows = [];
  const issues = [];

  function contextForNotice(notice, subscription) {
    const user = subscription?.user || {};
    return {
      user: userLabel(user, oid(notice?.user)),
      email: clean(user?.email),
      userId: oid(notice?.user || user?._id),
      serviceKey: clean(notice?.serviceKey || subscription?.serviceKey).toUpperCase(),
      periodKey: clean(notice?.periodKey),
    };
  }

  function pushIssue(type, severity, context = {}) {
    issues.push({ type, severity, ...context });
  }

  for (const notice of notices) {
    const subscription = subscriptionById.get(String(notice.subscription));
    const ctx = contextForNotice(notice, subscription);
    const { userId, serviceKey, periodKey } = ctx;
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
    const linkedPurchasedOrders = [...purchasedIds]
      .map((id) => linkedOrderById.get(id))
      .filter(Boolean);
    const paidLinked = linkedPurchasedOrders.filter((order) => paidStatus(order.status));

    rows.push({
      user: ctx.user,
      email: ctx.email,
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
        ...ctx,
        currentRequired,
        historicalRequired,
      });
    }

    if (purchased > 0) {
      if (linkedPurchasedOrders.length === 0) {
        pushIssue("PURCHASED_ORDER_LINK_MISSING", "REVIEW", {
          ...ctx,
          purchased,
          purchasedOrderIds: [...purchasedIds],
        });
      } else if (paidLinked.length === 0) {
        pushIssue("PURCHASED_ORDER_LINK_NOT_PAID", "REVIEW", {
          ...ctx,
          purchased,
          purchasedOrderIds: [...purchasedIds],
          linkedStatuses: linkedPurchasedOrders.map((order) => ({
            id: String(order._id),
            status: clean(order.status),
            kinds: orderKinds(order),
          })),
        });
      } else {
        const explicitSessions = paidLinked.reduce(
          (sum, order) => sum + sessionsForNoticeFromOrder(order, notice._id),
          0
        );
        if (explicitSessions !== purchased) {
          const legacyPaid = paidLinked.filter(
            (order) => sessionsForNoticeFromOrder(order, notice._id) === 0
          );
          if (legacyPaid.length > 0) {
            pushIssue("LEGACY_PAID_ORDER_LINK", "INFO", {
              ...ctx,
              purchased,
              explicitSessions,
              orders: legacyPaid.map((order) => ({
                id: String(order._id),
                status: clean(order.status),
                kinds: orderKinds(order),
              })),
            });
          } else {
            pushIssue("PURCHASED_SESSIONS_ORDER_MISMATCH", "REVIEW", {
              ...ctx,
              purchased,
              linkedPurchasedSessions: explicitSessions,
              purchasedOrderIds: [...purchasedIds],
            });
          }
        }
      }
    }

    const pendingOrderId = oid(notice?.pendingOrder);
    if (pendingOrderId) {
      const pendingOrder = linkedOrderById.get(pendingOrderId);
      const pendingStatus = clean(pendingOrder?.status).toLowerCase();
      if (!pendingOrder) {
        pushIssue("PENDING_ORDER_MISSING", "REVIEW", {
          ...ctx,
          orderId: pendingOrderId,
        });
      } else if (pendingStatus !== "pending") {
        pushIssue("PENDING_ORDER_STATUS_STALE", "REVIEW", {
          ...ctx,
          orderId: pendingOrderId,
          pendingStatus,
        });
      }
    }

    if (periodKey === currentPeriodKey) {
      const pairSubscriptions = subscriptionsByPair.get(pairKey(userId, serviceKey)) || [];
      const currentSubscription = pairSubscriptions[0] || subscription;
      const currentCycle = currentSubscription
        ? cycleBySubscription.get(String(currentSubscription._id))
        : null;
      const plan = Math.max(
        1,
        asInt(currentCycle?.planSnapshot?.monthlySessions) ||
          asInt(currentSubscription?.monthlySessions) ||
          asInt(notice.basePlanSessions)
      );
      const actualFixed = currentCountByPair.get(pairKey(userId, serviceKey)) || 0;
      const expectedRequired = Math.max(0, actualFixed - plan);

      if (expectedRequired < currentRequired) {
        pushIssue("CURRENT_NOTICE_STALE_OVERSTATED", "INFO", {
          ...ctx,
          subscriptionStatus: clean(currentSubscription?.status),
          actualFixed,
          plan,
          expectedRequired,
          noticeRequired: currentRequired,
        });
      } else if (expectedRequired > currentRequired) {
        pushIssue("CURRENT_NOTICE_UNDERSTATES_REQUIRED", "REVIEW", {
          ...ctx,
          subscriptionStatus: clean(currentSubscription?.status),
          actualFixed,
          plan,
          expectedRequired,
          noticeRequired: currentRequired,
        });
      }
    }
  }

  // Detecta deuda actual que ni siquiera tiene notice todavía.
  for (const [key, count] of currentCountByPair) {
    const [userId, serviceKey] = key.split(":");
    const pairSubscriptions = subscriptionsByPair.get(key) || [];
    const subscription = pairSubscriptions[0];
    if (!subscription) continue;
    const currentCycle = cycleBySubscription.get(String(subscription._id));
    const plan = Math.max(
      1,
      asInt(currentCycle?.planSnapshot?.monthlySessions) ||
        asInt(subscription?.monthlySessions)
    );
    const expectedRequired = Math.max(0, asInt(count) - plan);
    if (expectedRequired <= 0) continue;

    const notice = noticeByPairPeriod.get(
      periodPairKey(userId, serviceKey, currentPeriodKey)
    );
    if (notice) continue;

    pushIssue("CURRENT_REQUIRED_WITHOUT_NOTICE", "REVIEW", {
      user: userLabel(subscription?.user, userId),
      email: clean(subscription?.user?.email),
      userId,
      serviceKey,
      periodKey: currentPeriodKey,
      subscriptionStatus: clean(subscription?.status),
      actualFixed: asInt(count),
      plan,
      expectedRequired,
    });
  }

  // Bootstrap sin notice es historia, no deuda actual automática.
  for (const subscription of subscriptions) {
    const bootstrap = subscription?.bootstrap || {};
    const required = asInt(bootstrap?.extraSessionsRequired);
    const periodKey = clean(bootstrap?.monthKey);
    if (!required || !periodKey) continue;

    const userId = oid(subscription?.user?._id || subscription?.user);
    const serviceKey = clean(subscription?.serviceKey).toUpperCase();
    const matchingNotice = noticeByPairPeriod.get(
      periodPairKey(userId, serviceKey, periodKey)
    );
    if (matchingNotice) continue;

    const basePlan = Math.max(
      1,
      asInt(bootstrap?.basePlanSessions || subscription?.monthlySessions)
    );
    const paidCredits = asInt(
      bootstrap?.paidCredits || bootstrap?.latestPaidOrder?.sessions
    );
    const inferredPaid = Math.min(
      required,
      Math.max(0, paidCredits - basePlan)
    );
    const bootstrapOrderId = oid(bootstrap?.latestPaidOrder?.orderId);

    pushIssue("BOOTSTRAP_HISTORY_WITHOUT_NOTICE", "INFO", {
      user: userLabel(subscription?.user, userId),
      email: clean(subscription?.user?.email),
      subscriptionId: String(subscription._id),
      userId,
      serviceKey,
      periodKey,
      required,
      inferredPaid,
      orderId: inferredPaid > 0 ? bootstrapOrderId : "",
    });

    if (inferredPaid > 0) {
      const order = bootstrapOrderId ? linkedOrderById.get(bootstrapOrderId) : null;
      if (!order) {
        pushIssue("BOOTSTRAP_INFERRED_PAYMENT_ORDER_MISSING", "REVIEW", {
          user: userLabel(subscription?.user, userId),
          email: clean(subscription?.user?.email),
          subscriptionId: String(subscription._id),
          userId,
          serviceKey,
          periodKey,
          required,
          inferredPaid,
          orderId: bootstrapOrderId,
        });
      } else if (!paidStatus(order.status)) {
        pushIssue("BOOTSTRAP_INFERRED_PAYMENT_ORDER_NOT_PAID", "REVIEW", {
          user: userLabel(subscription?.user, userId),
          email: clean(subscription?.user?.email),
          subscriptionId: String(subscription._id),
          userId,
          serviceKey,
          periodKey,
          required,
          inferredPaid,
          orderId: bootstrapOrderId,
          status: clean(order.status),
        });
      }
    }
  }

  for (const order of explicitExtraOrders) {
    if (!paidStatus(order.status)) continue;
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

  const severityCounts = issues.reduce((acc, issue) => {
    acc[issue.severity] = (acc[issue.severity] || 0) + 1;
    return acc;
  }, {});
  const typeCounts = issues.reduce((acc, issue) => {
    acc[issue.type] = (acc[issue.type] || 0) + 1;
    return acc;
  }, {});

  console.log("\nAUDITORÍA PLANES + DIFERENCIAS + ÓRDENES V2 (SOLO LECTURA)\n");
  console.log({
    currentPeriodKey,
    subscriptions: subscriptions.length,
    notices: notices.length,
    explicitExtraOrders: explicitExtraOrders.length,
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
        user: issue.user || "",
        email: issue.email || "",
        userId: issue.userId || "",
        service: issue.serviceKey || "",
        period: issue.periodKey || "",
        orderId: issue.orderId || "",
        detail: JSON.stringify(
          Object.fromEntries(
            Object.entries(issue).filter(
              ([key]) =>
                ![
                  "severity",
                  "type",
                  "user",
                  "email",
                  "userId",
                  "serviceKey",
                  "periodKey",
                  "orderId",
                ].includes(key)
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
      : "\nRESULTADO: sin hallazgos REVIEW. NO SE MODIFICÓ NINGÚN DATO."
  );
} finally {
  await mongoose.disconnect();
}
