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
    const from = parseDateStart(query.from) || new Date(now.getFullYear(), now.getMonth(), 1);
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
      { "subject.name": { $regex: search, $options: "i" } },
      { entity: { $regex: search, $options: "i" } },
      { action: { $regex: search, $options: "i" } },
    ];
  }

  return match;
}

router.get("/summary", async (req, res) => {
  try {
    const { from, to, preset } = resolveRange(req.query || {});

    const [
      orderAgg,
      reservedCount,
      cancelledCount,
      completedCount,
      usersCreatedCount,
      evaluationsCreatedCount,
      activityBreakdown,
    ] = await Promise.all([
      Order.aggregate([
        { $match: buildDateMatch("createdAt", from, to) },
        {
          $group: {
            _id: null,
            ordersCount: { $sum: 1 },
            ordersPaidCount: {
              $sum: { $cond: [{ $in: ["$status", ["paid", "approved"]] }, 1, 0] },
            },
            ordersPendingCount: {
              $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
            },
            ordersCancelledCount: {
              $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
            },
            totalAll: { $sum: { $ifNull: ["$totalFinal", "$total"] } },
            totalPaid: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["paid", "approved"]] },
                  { $ifNull: ["$totalFinal", "$total"] },
                  0,
                ],
              },
            },
            totalPending: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "pending"] },
                  { $ifNull: ["$totalFinal", "$total"] },
                  0,
                ],
              },
            },
          },
        },
      ]),
      Appointment.countDocuments({ ...buildDateMatch("createdAt", from, to), status: "reserved" }),
      Appointment.countDocuments({ ...buildDateMatch("createdAt", from, to), status: "cancelled" }),
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
    ]);

    const o = orderAgg?.[0] || {};

    const [deletedEvaluations, creditMutations, totalActivities] = await Promise.all([
      ActivityLog.countDocuments({
        ...buildDateMatch("createdAt", from, to),
        category: "evaluations",
        action: "evaluation_deleted",
      }),
      ActivityLog.countDocuments({
        ...buildDateMatch("createdAt", from, to),
        category: "users",
        action: "credits_updated",
      }),
      ActivityLog.countDocuments(buildDateMatch("createdAt", from, to)),
    ]);

    return res.json({
      ok: true,
      range: { preset, from, to },
      cards: {
        ordersCount: Number(o.ordersCount || 0),
        ordersPaidCount: Number(o.ordersPaidCount || 0),
        ordersPendingCount: Number(o.ordersPendingCount || 0),
        ordersCancelledCount: Number(o.ordersCancelledCount || 0),
        ordersTotalAll: Number(o.totalAll || 0),
        ordersTotalPaid: Number(o.totalPaid || 0),
        ordersTotalPending: Number(o.totalPending || 0),
        appointmentsReservedCount: Number(reservedCount || 0),
        appointmentsCancelledCount: Number(cancelledCount || 0),
        appointmentsCompletedCount: Number(completedCount || 0),
        usersCreatedCount: Number(usersCreatedCount || 0),
        evaluationsCreatedCount: Number(evaluationsCreatedCount || 0),
        evaluationsDeletedCount: Number(deletedEvaluations || 0),
        creditMutationsCount: Number(creditMutations || 0),
        totalActivities: Number(totalActivities || 0),
      },
      activityBreakdown: activityBreakdown || [],
    });
  } catch (err) {
    console.error("GET /admin/dashboard/summary error:", err);
    return res.status(500).json({ ok: false, error: "No se pudo cargar el resumen." });
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
      ActivityLog.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
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
    return res.status(500).json({ ok: false, error: "No se pudo cargar la actividad." });
  }
});

export default router;
