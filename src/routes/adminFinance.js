import { dashboardFixedDifferences } from "./adminPlans.js";
import express from "express";
import mongoose from "mongoose";
import { protect, adminOnly } from "../middleware/auth.js";
import FinanceEntry from "../models/FinanceEntry.js";
import ServiceDefinition from "../models/ServiceDefinition.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import Appointment, { effectiveAttendanceStatus } from "../models/Appointment.js";
import Admission from "../models/Admission.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import { logActivity } from "../lib/activityLogger.js";
import analyticsRoutes from "./financeAnalytics.js";
import createWorkRoutes, { laborRows, sector, groupFilter } from "./financeWork.js";
const router = express.Router();
router.use(protect, (req, res, next) => ["admin", "staff"].includes(req.user.role) ? next() : res.status(403).json({
  error: "No autorizado."
}));
const TZ = "America/Argentina/Buenos_Aires";
const DAY = 86400000;
const fail = (message, status = 400) => Object.assign(new Error(message), {
  status
});
export function argentinaDay(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type).value).join("-");
}
export function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [y, m, d] = value.split("-").map(Number),
    date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 9999 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export function resolveFinanceRange(query = {}) {
  const today = argentinaDay(),
    fromDay = String(query.from || today.slice(0, 7) + "-01"),
    toDay = String(query.to || today);
  if (!validDay(fromDay) || !validDay(toDay)) throw fail("Ingresá fechas válidas para el período.");
  if (fromDay > toDay) throw fail("La fecha final debe ser igual o posterior a la inicial.");
  const from = new Date(fromDay + "T00:00:00-03:00"),
    end = new Date(new Date(toDay + "T00:00:00-03:00").getTime() + DAY);
  if ((end - from) / DAY > 366) throw fail("Elegí un período de hasta 366 días.");
  return {
    fromDay,
    toDay,
    from,
    end
  };
}
export function parseAmountCents(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,10}(?:[.,]\d{1,2})?$/.test(text)) throw fail("Ingresá un importe positivo, sin separadores de miles y con hasta dos decimales.");
  const [whole, fraction = ""] = text.replace(",", ".").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 1000000000000) throw fail("El importe debe ser mayor a cero y estar dentro del límite permitido.");
  return cents;
}
const clean = value => String(value ?? "").trim();
export function normalizeEntry(body) {
  const type = clean(body.type),
    date = clean(body.date),
    method = clean(body.method),
    category = clean(body.category),
    description = clean(body.description),
    reference = clean(body.reference),
    requestKey = clean(body.requestKey);
  if (!["income", "expense"].includes(type)) throw fail("Elegí ingreso o gasto.");
  if (!validDay(date) || date > argentinaDay()) throw fail("La fecha del movimiento debe ser hoy o anterior.");
  if (!["CASH", "TRANSFER", "MP", "OTHER"].includes(method)) throw fail("Elegí un medio válido.");
  if (!category || category.length > 80 || !description || description.length > 500 || reference.length > 120) throw fail("Completá categoría y concepto respetando su longitud máxima.");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) throw fail("Falta la identificación del movimiento. Volvé a abrir el formulario.");
  if (clean(body.section || "General").length > 80 || clean(body.paidBy || "Caja/DUO").length > 80) throw fail("Sección o pagador demasiado largo.");
  if (body.orderId || body.order) throw fail("Los cobros de Órdenes ya se incluyen automáticamente; no los cargues como ingreso manual.");
  return {
    type,
    date,
    method,
    category,
    description,
    reference,
    section: sector(body.section),
    paidBy: clean(body.paidBy || "Caja/DUO"),
    requestKey,
    amountCents: parseAmountCents(body.amount)
  };
}
const sameEntry = (entry, payload) => ["type", "date", "method", "category", "description", "reference", "amountCents", "section", "paidBy"].every(key => entry[key] === payload[key]);
const orderCategory = order => order.items?.some(item => item.kind === "SUBSCRIPTION_RENEWAL") ? "Planes mensuales" : order.items?.some(item => item.kind === "SUBSCRIPTION_EXTRA") ? "Sesiones adicionales" : order.externalPaymentCard ? "Cobros externos" : "Sesiones y servicios";
export async function financeReport(query = {}) {
  const range = resolveFinanceRange(query);
  const group = clean(query.group);
  if (group) sector(group);
  const type = clean(query.type),
    source = clean(query.source),
    q = clean(query.q).toLocaleLowerCase("es-AR");
  if (type && !["income", "expense"].includes(type)) throw fail("Filtro de tipo inválido.");
  if (source && !["orders", "manual", "labor"].includes(source)) throw fail("Filtro de origen inválido.");
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const [orders, entries] = await Promise.all([source === "manual" || source === "labor" || type === "expense" ? [] : Order.find({
    status: {
      $in: ["paid", "approved"]
    },
    $expr: {
      $and: [{
        $gte: [{
          $ifNull: ["$paidAt", {
            $ifNull: ["$approvedAt", "$createdAt"]
          }]
        }, range.from]
      }, {
        $lt: [{
          $ifNull: ["$paidAt", {
            $ifNull: ["$approvedAt", "$createdAt"]
          }]
        }, range.end]
      }]
    }
  }).select("status paidAt approvedAt createdAt totalFinal total price serviceKey items.serviceKey items.price items.label items.kind payMethod customerName externalPaymentCard label user").populate("user", "name lastName").lean(), source === "orders" || source === "labor" ? [] : FinanceEntry.find({
    ...groupFilter(group),
    date: {
      $gte: range.fromDay,
      $lte: range.toDay
    },
    ...(query.includeVoided === "1" ? {} : {
      status: "active"
    }),
    ...(type ? {
      type
    } : {})
  }).lean()]);
  const definitions = await ServiceDefinition.find({}).select("serviceKey capacityGroup").lean();
  const groups = new Map(definitions.map(d => [d.serviceKey, d.capacityGroup]));
  const getGroup = key => groups.has(key) ? {
    TRAINING: "Training",
    PERFORMANCE: "Performance"
  }[groups.get(key)] || "General" : {
    EP: "Training",
    RA: "Performance",
    RF: "Performance",
    SYN: "Performance",
    KD: "Performance"
  }[key] || "General";
  const automatic = orders.flatMap(order => {
    const total = Math.round(Number(order.totalFinal ?? order.total ?? order.price ?? 0) * 100);
    const weights = new Map();
    for (const item of order.items || []) {
      const section = getGroup(item.serviceKey);
      weights.set(section, (weights.get(section) || 0) + Math.max(0, Number(item.price) || 0));
    }
    const sum = [...weights.values()].reduce((a, b) => a + b, 0);
    if (!sum) {
      weights.clear();
      weights.set(getGroup(order.serviceKey), 1);
    }
    const denominator = sum || 1;
    let assigned = 0;
    const allocation = [...weights].filter(([, w]) => w > 0);
    return allocation.map(([section, w], index) => {
      const cents = index === allocation.length - 1 ? total - assigned : Math.round(total * w / denominator);
      assigned += cents;
      return {
        id: String(order._id) + "-" + section,
        section,
        orderId: String(order._id),
        source: "orders",
        type: "income",
        date: argentinaDay(order.paidAt || order.approvedAt || order.createdAt),
        sortAt: new Date(order.paidAt || order.approvedAt || order.createdAt).getTime(),
        dateEstimated: !order.paidAt && !order.approvedAt,
        amountCents: cents,
        category: orderCategory(order),
        description: clean(order.customerName) || [order.user?.name, order.user?.lastName].filter(Boolean).join(" ") || clean(order.label) || "Cobro de orden",
        method: order.payMethod || "OTHER",
        reference: "Orden #" + String(order._id).slice(-8),
        status: "active"
      };
    });
  }).filter(row => (!group || row.section === sector(group)) && Number.isSafeInteger(row.amountCents) && row.amountCents > 0);
  const manual = entries.map(entry => ({
    id: String(entry._id),
    source: "manual",
    type: entry.type,
    date: entry.date,
    sortAt: new Date(entry.date + "T12:00:00-03:00").getTime(),
    amountCents: entry.amountCents,
    category: entry.category,
    description: entry.description,
    method: entry.method,
    reference: entry.reference,
    status: entry.status,
    voidReason: entry.voidReason,
    voidedAt: entry.voidedAt,
    section: entry.section,
    paidBy: entry.paidBy,
    revision: entry.revision || 0
  }));
  const labor = type === "income" || source === "orders" || source === "manual" ? [] : await laborRows(range.fromDay, range.toDay, query.includeVoided === "1", group);
  const rows = [...automatic, ...manual, ...labor].filter(row => !q || [row.description, row.category, row.reference, row.method].join(" ").toLocaleLowerCase("es-AR").includes(q)).sort((a, b) => b.date.localeCompare(a.date) || b.sortAt - a.sortAt || b.id.localeCompare(a.id));
  const live = rows.filter(row => row.status === "active"),
    stats = {
      incomeCents: 0,
      expenseCents: 0,
      resultCents: 0,
      movements: new Set(live.map(row => row.source + ":" + (row.orderId || row.id))).size,
      automaticIncomeCents: 0,
      manualIncomeCents: 0,
      estimatedDateCount: 0,
      laborCents: 0,
      unpricedMinutes: 0
    };
  const days = new Map(),
    expenses = new Map(),
    methods = new Map();
  for (let stamp = range.from.getTime(); stamp < range.end.getTime(); stamp += DAY) days.set(argentinaDay(stamp), {
    date: argentinaDay(stamp),
    incomeCents: 0,
    expenseCents: 0
  });
  for (const row of live) {
    const key = row.type === "income" ? "incomeCents" : "expenseCents";
    if (row.source === "labor") {
      stats.laborCents += row.amountCents;
      if (row.unpriced) stats.unpricedMinutes += row.minutes;
    }
    stats[key] += row.amountCents;
    days.get(row.date)[key] += row.amountCents;
    if (row.type === "expense") expenses.set(row.category, (expenses.get(row.category) || 0) + row.amountCents);else {
      stats[row.source === "orders" ? "automaticIncomeCents" : "manualIncomeCents"] += row.amountCents;
      methods.set(row.method, (methods.get(row.method) || 0) + row.amountCents);
    }
  }
  stats.estimatedDateCount = new Set(live.filter(row => row.dateEstimated).map(row => row.orderId || row.id)).size;
  stats.resultCents = stats.incomeCents - stats.expenseCents;
  const pages = Math.max(1, Math.ceil(rows.length / 50)),
    safePage = Math.min(page, pages);
  return {
    range: {
      from: range.fromDay,
      to: range.toDay
    },
    group: group ? sector(group) : "",
    stats,
    daily: [...days.values()],
    expenseCategories: [...expenses].map(([label, value]) => ({
      label,
      value
    })).sort((a, b) => b.value - a.value),
    incomeMethods: [...methods].map(([label, value]) => ({
      label,
      value
    })).sort((a, b) => b.value - a.value),
    items: rows.slice((safePage - 1) * 50, safePage * 50),
    pagination: {
      page: safePage,
      pages,
      total: rows.length,
      from: rows.length ? (safePage - 1) * 50 + 1 : 0,
      to: Math.min(safePage * 50, rows.length)
    },
    rows
  };
}
router.use(createWorkRoutes({
  argentinaDay,
  resolveFinanceRange,
  normalizeEntry
}));
router.use("/analytics", analyticsRoutes({
  financeReport,
  argentinaDay
}));
router.use((req, res, next) => {
  if (req.user.role === "admin") return next();
  if (req.method === "POST" && req.path === "/entries") return next();
  if (req.method === "PATCH" && /^\/entries\/[a-f0-9]{24}\/void$/i.test(req.path)) return next();
  return res.status(403).json({
    error: "El staff solo puede gestionar sus movimientos y horas del día."
  });
});
router.get("/overview", async (req, res) => {
  try {
    const range = resolveFinanceRange(req.query),
      now = new Date(),
      today = argentinaDay(now),
      active = {
        accountDeactivated: {
          $ne: true
        }
      };
    const [appointments, clientIds, pendingUsers, aptoReview, admissions, finance] = await Promise.all([Appointment.find({
      date: {
        $gte: range.fromDay,
        $lte: range.toDay
      }
    }).select("date time status attendanceStatus serviceKey").lean(), User.distinct("_id", {
      ...active,
      role: "client"
    }), User.countDocuments({
      ...active,
      approvalStatus: "pending",
      role: "client"
    }), User.countDocuments({
      ...active,
      role: "client",
      $or: [{
        "medicalClearance.status": "pending_review"
      }, {
        aptoStatus: "pending_review"
      }]
    }), Admission.countDocuments({
      syncedToUser: {
        $ne: true
      }
    }), financeReport({
      from: range.fromDay,
      to: range.toDay
    })]);
    const [activePlans, newClients, todayRows, differences] = await Promise.all([ServiceSubscription.countDocuments({
      user: {
        $in: clientIds
      },
      status: {
        $in: ["active", "pending_change"]
      }
    }), User.countDocuments({
      ...active,
      role: "client",
      createdAt: {
        $gte: range.from,
        $lt: range.end
      }
    }), today >= range.fromDay && today <= range.toDay ? appointments.filter(row => row.date === today) : Appointment.find({
      date: today
    }).select("date time status attendanceStatus serviceKey").lean(), dashboardFixedDifferences()]);
    const live = appointments.filter(row => row.status !== "cancelled"),
      services = new Map();
    let present = 0,
      absent = 0;
    for (const row of live) {
      const attendance = effectiveAttendanceStatus(row, now);
      if (attendance === "present") present++;
      if (attendance === "absent") absent++;
      services.set(row.serviceKey, (services.get(row.serviceKey) || 0) + 1);
    }
    const weekdays = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map(label => ({label, count: 0, days: 0, average: 0}));
    const weekdayIndex = date => (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7;
    for (let stamp = Date.parse(range.fromDay + "T12:00:00Z"); stamp <= Date.parse(range.toDay + "T12:00:00Z"); stamp += DAY) weekdays[(new Date(stamp).getUTCDay() + 6) % 7].days++;
    for (const row of live) weekdays[weekdayIndex(row.date)].count++;
    for (const row of weekdays) row.average = row.days ? row.count / row.days : 0;
    const upcoming = todayRows.filter(row => row.status === "reserved" && new Date(row.date + "T" + row.time + ":00-03:00") > now),
      slots = new Map();
    for (const row of upcoming) {
      const key = row.time + "-" + row.serviceKey;
      const slot = slots.get(key) || {
        time: row.time,
        serviceKey: row.serviceKey,
        count: 0
      };
      slot.count++;
      slots.set(key, slot);
    }
    return res.json({
      range: {
        from: range.fromDay,
        to: range.toDay
      },
      computedAt: now,
      weekdays,
      differences,
      today: {
        date: today,
        reservations: todayRows.filter(row => row.status !== "cancelled").length,
        upcoming: upcoming.length,
        next: [...slots.values()].sort((a, b) => a.time.localeCompare(b.time) || a.serviceKey.localeCompare(b.serviceKey)).slice(0, 5)
      },
      stats: {
        reservations: live.length,
        present,
        absent,
        attendanceRate: present + absent ? Math.round(present / (present + absent) * 100) : null,
        newClients,
        activeClients: clientIds.length,
        activePlans,
        cancelled: appointments.length - live.length
      },
      tasks: {
        pendingUsers,
        aptoReview,
        admissions
      },
      services: [...services].map(([label, value]) => ({
        label,
        value
      })).sort((a, b) => b.value - a.value),
      finance: finance.stats
    });
  } catch (error) {
    console.error("Finance overview", error);
    return res.status(error.status || 500).json({
      error: error.status ? error.message : "No se pudo cargar el dashboard."
    });
  }
});
router.get("/export", async (req, res) => {
  try {
    const report = await financeReport(req.query);
    const esc = value => {
      let v = String(value ?? "");
      if (/^[=+@\-\t\r]/.test(v) && !/^-?\d+(?:\.\d+)?$/.test(v)) v = "'" + v;
      return '"' + v.replace(/"/g, '""') + '"';
    };
    const lines = [["Fecha", "Tipo", "Concepto", "Categoría", "Medio", "Origen", "Importe computable ARS", "Importe original ARS", "Estado", "Referencia", "Grupo", "Lo pagó", "Observación"]];
    for (const row of report.rows) lines.push([row.date, row.type === "income" ? "Ingreso" : "Gasto", row.description, row.category, row.method, row.source === "orders" ? "Orden" : row.source === "labor" ? "Horas" : "Manual", ((row.status === "active" ? row.amountCents : 0) * (row.type === "income" ? 1 : -1) / 100).toFixed(2), (row.amountCents / 100).toFixed(2), row.status === "active" ? "Registrado" : "Anulado", row.reference, row.section || "General", row.paidBy || "", row.unpriced ? "Sin tarifa: costo incompleto" : row.dateEstimated ? "Fecha estimada" : ""]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="finanzas-${report.range.from}-${report.range.to}.csv"`);
    return res.send("\uFEFF" + lines.map(line => line.map(esc).join(",")).join("\r\n"));
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.status ? error.message : "No se pudo exportar el período."
    });
  }
});
router.get("/", async (req, res) => {
  try {
    const {
      rows,
      ...report
    } = await financeReport(req.query);
    res.json(report);
  } catch (error) {
    console.error("Finance report", error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "No se pudieron consultar las finanzas."
    });
  }
});
router.post("/entries", async (req, res) => {
  try {
    const payload = normalizeEntry(req.body || {});
    if (req.user.role !== "admin" && payload.date !== argentinaDay()) throw fail("Solo podés registrar movimientos de hoy.", 403);
    const key = {
      createdBy: req.user._id,
      requestKey: payload.requestKey
    };
    let existing = await FinanceEntry.findOne(key);
    if (existing) {
      if (!sameEntry(existing, payload)) throw fail("Esta identificación ya se usó para otro movimiento.", 409);
      return res.json({
        ok: true,
        reused: true,
        item: existing
      });
    }
    let entry;
    try {
      entry = await FinanceEntry.create({
        ...payload,
        createdBy: req.user._id
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      existing = await FinanceEntry.findOne(key);
      if (!existing || !sameEntry(existing, payload)) throw fail("Esta identificación ya se usó para otro movimiento.", 409);
      return res.json({
        ok: true,
        reused: true,
        item: existing
      });
    }
    await logActivity({
      req,
      category: "finance",
      action: "finance_entry_created",
      entity: "finance",
      entityId: entry._id,
      title: payload.type === "income" ? "Ingreso manual registrado" : "Gasto registrado",
      description: payload.description,
      meta: {
        amountCents: payload.amountCents,
        date: payload.date,
        category: payload.category
      }
    });
    return res.status(201).json({
      ok: true,
      item: entry
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "No se pudo registrar el movimiento."
    });
  }
});
router.patch("/entries/:id/void", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw fail("Movimiento inválido.");
    const reason = clean(req.body?.reason);
    if (reason.length < 3 || reason.length > 300) throw fail("Indicá el motivo de anulación (entre 3 y 300 caracteres).");
    const today = argentinaDay();
    const staffFilter = req.user.role === "admin" ? {} : {
      createdBy: req.user._id,
      date: today,
      createdAt: {
        $gte: new Date(today + "T00:00:00-03:00")
      }
    };
    const item = await FinanceEntry.findOneAndUpdate({
      ...staffFilter,
      _id: req.params.id,
      status: "active"
    }, {
      $set: {
        status: "void",
        voidReason: reason,
        voidedAt: new Date(),
        voidedBy: req.user._id
      }
    }, {
      new: true
    });
    if (!item) {
      const existing = await FinanceEntry.findById(req.params.id);
      if (!existing) throw fail("Movimiento no encontrado.", 404);
      if (req.user.role !== "admin" && (String(existing.createdBy) !== String(req.user._id) || existing.date !== today || argentinaDay(existing.createdAt) !== today)) throw fail("Solo podés modificar tus registros de hoy.", 403);
      return res.json({
        ok: true,
        item: existing
      });
    }
    await logActivity({
      req,
      category: "finance",
      action: "finance_entry_voided",
      entity: "finance",
      entityId: item._id,
      title: "Movimiento anulado",
      description: reason,
      meta: {
        amountCents: item.amountCents
      }
    });
    return res.json({
      ok: true,
      item
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : "No se pudo anular el movimiento."
    });
  }
});
export default router;
