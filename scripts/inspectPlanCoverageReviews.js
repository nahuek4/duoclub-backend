// scripts/inspectPlanCoverageReviews.js
// SOLO LECTURA. Diagnóstico puntual previo a reconciliar Planes/diferencias.
import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import SubscriptionExtraSessionNotice from "../src/models/SubscriptionExtraSessionNotice.js";

const uri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URL ||
  process.env.DATABASE_URL ||
  process.env.MONGO;
if (!uri) throw new Error("No encontré URI de Mongo en .env");

const periodKey = "2026-09";
const userIds = [
  "6a2a88fc9f3a650979fbabd4", // orden links faltantes
  "6a6a7bd2cd1bb8a1e6b995e1", // María Celeste
  "6a69fe2dcd1bb8a1e6b8f92c", // Leonard
  "6a8795558a9771b6606ea689", // Camila
  "6a1ee6fc0b45560aaab309ac", // Soledad
  "6a933a974f545e732e59fbc5", // RA sin suscripción
].map((id) => new mongoose.Types.ObjectId(id));

const linkedOrderIds = [
  "6a7d703b48e66ea524728188",
  "6a970accc86f4794f0dbc13c",
].map((id) => new mongoose.Types.ObjectId(id));

await mongoose.connect(uri);
try {
  const [users, notices, subscriptions, cycles, linkedOrders, candidateOrders, appointmentRows, fixedSchedules] =
    await Promise.all([
      User.find({ _id: { $in: userIds } })
        .select("name lastName fullName email role")
        .lean(),
      SubscriptionExtraSessionNotice.find({
        user: { $in: userIds },
        periodKey: { $in: ["2026-08", "2026-09"] },
      })
        .sort({ periodKey: 1, serviceKey: 1 })
        .lean(),
      ServiceSubscription.find({ user: { $in: userIds } })
        .select("user serviceKey monthlySessions status currentPeriodKey bootstrap createdAt updatedAt")
        .sort({ user: 1, serviceKey: 1, updatedAt: -1 })
        .lean(),
      SubscriptionBillingCycle.find({
        user: { $in: userIds },
        periodKey,
      })
        .select("subscription user serviceKey periodKey planSnapshot billing lifecycle")
        .lean(),
      Order.find({ _id: { $in: linkedOrderIds } })
        .select("_id user status payMethod total totalFinal paidAt approvedAt createdAt items service serviceName serviceKey credits applied creditsApplied createdByAdmin")
        .lean(),
      Order.find({
        user: new mongoose.Types.ObjectId("6a2a88fc9f3a650979fbabd4"),
        status: { $regex: "^(paid|approved)$", $options: "i" },
        createdAt: {
          $gte: new Date("2026-08-01T00:00:00-03:00"),
          $lt: new Date("2026-10-01T00:00:00-03:00"),
        },
      })
        .select("_id user status payMethod total totalFinal paidAt approvedAt createdAt items service serviceName serviceKey credits applied creditsApplied createdByAdmin")
        .sort({ createdAt: 1 })
        .lean(),
      Appointment.aggregate([
        {
          $match: {
            user: { $in: userIds },
            fixedScheduleId: { $ne: null },
            date: { $gte: "2026-09-01", $lte: "2026-09-30" },
          },
        },
        {
          $group: {
            _id: { user: "$user", serviceKey: "$serviceKey", status: "$status" },
            count: { $sum: 1 },
            dates: { $push: { date: "$date", time: "$time", id: "$_id" } },
          },
        },
        { $sort: { "_id.user": 1, "_id.serviceKey": 1, "_id.status": 1 } },
      ]),
      FixedSchedule.find({ user: { $in: userIds } })
        .select("_id user serviceKey active startDate endDate items createdAt updatedAt")
        .sort({ user: 1, serviceKey: 1, createdAt: 1 })
        .lean(),
    ]);

  const userById = new Map(users.map((u) => [String(u._id), u]));
  const label = (id) => {
    const u = userById.get(String(id));
    return u
      ? `${u.fullName || [u.name, u.lastName].filter(Boolean).join(" ") || "Usuario"} <${u.email || ""}>`
      : `${String(id)} [USER NO ENCONTRADO]`;
  };

  console.log("\nINSPECCIÓN PLAN COVERAGE REVIEWS (SOLO LECTURA)\n");
  console.log("USUARIOS:");
  console.table(userIds.map((id) => ({ userId: String(id), user: label(id) })));

  console.log("\nNOTICES:");
  console.dir(
    notices.map((n) => ({
      id: String(n._id),
      user: label(n.user),
      subscription: String(n.subscription || ""),
      serviceKey: n.serviceKey,
      periodKey: n.periodKey,
      basePlanSessions: n.basePlanSessions,
      projectedFixedOccurrences: n.projectedFixedOccurrences,
      extraSessionsRequired: n.extraSessionsRequired,
      extraSessionsPurchased: n.extraSessionsPurchased,
      historicalBasePlanSessions: n.historicalBasePlanSessions,
      historicalFixedOccurrences: n.historicalFixedOccurrences,
      historicalExtraSessionsRequired: n.historicalExtraSessionsRequired,
      status: n.status,
      source: n.source,
      pendingOrder: String(n.pendingOrder || ""),
      lastPaidOrder: String(n.lastPaidOrder || ""),
      purchasedOrderIds: (n.purchasedOrderIds || []).map(String),
    })),
    { depth: null }
  );

  console.log("\nSUSCRIPCIONES:");
  console.dir(
    subscriptions.map((s) => ({
      id: String(s._id),
      user: label(s.user),
      serviceKey: s.serviceKey,
      monthlySessions: s.monthlySessions,
      status: s.status,
      currentPeriodKey: s.currentPeriodKey,
      bootstrap: s.bootstrap || null,
    })),
    { depth: null }
  );

  console.log("\nCICLOS SEPTIEMBRE:");
  console.dir(
    cycles.map((c) => ({
      id: String(c._id),
      subscription: String(c.subscription),
      user: label(c.user),
      serviceKey: c.serviceKey,
      periodKey: c.periodKey,
      planSessions: c.planSnapshot?.monthlySessions,
      billing: c.billing,
      lifecycle: c.lifecycle,
    })),
    { depth: null }
  );

  console.log("\nÓRDENES REFERENCIADAS POR PURCHASED ORDER IDS:");
  console.dir(linkedOrders, { depth: null });

  console.log("\nÓRDENES PAGADAS CANDIDATAS DE NAHUEL (AGO-SEP):");
  console.dir(candidateOrders, { depth: null });

  console.log("\nTURNOS FIJOS SEPTIEMBRE POR ESTADO:");
  console.dir(
    appointmentRows.map((r) => ({
      user: label(r._id.user),
      serviceKey: r._id.serviceKey,
      status: r._id.status,
      count: r.count,
      dates: r.dates,
    })),
    { depth: null }
  );

  console.log("\nFIXED SCHEDULES:");
  console.dir(
    fixedSchedules.map((f) => ({
      id: String(f._id),
      user: label(f.user),
      serviceKey: f.serviceKey,
      active: f.active,
      startDate: f.startDate,
      endDate: f.endDate,
      items: f.items,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
    { depth: null }
  );

  console.log("\nFIN. NO SE MODIFICÓ NINGÚN DATO.");
} finally {
  await mongoose.disconnect();
}
