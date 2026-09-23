// scripts/auditReleasedFixedSchedules.js
// SOLO LECTURA: no modifica MongoDB.
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

const TZ = "America/Argentina/Buenos_Aires";
const clean = (v) => String(v ?? "").trim();
const idOf = (v) => clean(v?._id || v?.id || v);
const sk = (v) => clean(v).toUpperCase();
const pad2 = (v) => String(v).padStart(2, "0");

function arParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function currentPeriodKey() {
  const p = arParts();
  return `${p.year}-${pad2(p.month)}`;
}

function periodBounds(periodKey) {
  if (!/^\d{4}-\d{2}$/.test(periodKey)) throw new Error("Usá --period=YYYY-MM");
  const [year, month] = periodKey.split("-").map(Number);
  const last = new Date(year, month, 0, 12, 0, 0).getDate();
  return {
    startYmd: `${periodKey}-01`,
    endYmd: `${periodKey}-${pad2(last)}`,
    startDate: new Date(`${periodKey}-01T00:00:00-03:00`),
    endDate: new Date(`${periodKey}-${pad2(last)}T23:59:59.999-03:00`),
  };
}

function parseArgs() {
  let selector = "";
  let periodKey = currentPeriodKey();
  let all = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === "--all") all = true;
    else if (arg.startsWith("--period=")) periodKey = clean(arg.slice(9));
    else if (!arg.startsWith("--") && !selector) selector = clean(arg);
  }

  return { selector, periodKey, all };
}

function orderItems(order = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  const rows = items
    .filter((it) => ["CREDITS", "SUBSCRIPTION_RENEWAL"].includes(sk(it?.kind)))
    .map((it) => ({
      kind: sk(it?.kind),
      serviceKey: sk(it?.serviceKey),
      credits: Number(it?.credits || 0),
      subscription: idOf(it?.subscription),
      subscriptionCycle: idOf(it?.subscriptionCycle),
      periodKey: clean(it?.periodKey),
      price: Number(it?.price || 0),
    }))
    .filter((it) => it.serviceKey);

  if (rows.length) return rows;
  if (order?.serviceKey && Number(order?.credits || 0) > 0) {
    return [{
      kind: "LEGACY_CREDITS",
      serviceKey: sk(order.serviceKey),
      credits: Number(order.credits || 0),
      subscription: "",
      subscriptionCycle: "",
      periodKey: "",
      price: Number(order?.price || order?.total || 0),
    }];
  }
  return [];
}

function cancelledByNonPayment(ap = {}) {
  const reason = clean(ap.cancelReason).toLowerCase();
  return reason.includes("falta de pago") || reason.includes("plan mensual");
}

async function findUser(selector) {
  if (!selector) return null;
  if (mongoose.Types.ObjectId.isValid(selector)) return User.findById(selector).lean();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return User.findOne({ email: { $regex: `^${escaped}$`, $options: "i" } }).lean();
}

async function findUsersToAudit(periodKey) {
  const releasedUserIds = await FixedSchedule.distinct("user", {
    active: false,
    lastAutoReleasedMonthKey: periodKey,
  });

  const blockedSubscriptions = await ServiceSubscription.find({
    status: { $in: ["suspended", "terminated_for_non_payment"] },
  })
    .select("user")
    .lean();

  const problematicCycles = await SubscriptionBillingCycle.find({
    periodKey,
    $or: [
      { "billing.status": { $in: ["pending", "overdue"] } },
      { "lifecycle.planStatus": { $in: ["suspended", "terminated"] } },
    ],
  })
    .select("user")
    .lean();

  const ids = new Set(releasedUserIds.map(String));

  for (const row of blockedSubscriptions) {
    if (row?.user) ids.add(String(row.user));
  }

  for (const row of problematicCycles) {
    if (row?.user) ids.add(String(row.user));
  }

  if (!ids.size) return [];

  return User.find({ _id: { $in: [...ids] } })
    .sort({ email: 1, name: 1, lastName: 1 })
    .lean();
}

function isSuspiciousDiagnostic(value) {
  return [
    "TERMINATED_DESPITE_PAID_ORDER",
    "SUSPENDED_DESPITE_PAID_ORDER",
    "PAID_ORDER_BUT_CYCLE_UNPAID",
  ].includes(clean(value));
}

function auditSummary(audits = []) {
  const affected = [];
  const suspicious = [];

  for (const audit of audits) {
    const rows = Array.isArray(audit?.serviceAudits) ? audit.serviceAudits : [];
    const releasedRows = rows.filter(
      (row) =>
        (Array.isArray(row?.releasedFixedSchedules) &&
          row.releasedFixedSchedules.length > 0) ||
        (Array.isArray(row?.cancelledAppointments) &&
          row.cancelledAppointments.length > 0) ||
        ["suspended", "terminated_for_non_payment"].includes(
          clean(row?.subscription?.status).toLowerCase()
        )
    );

    const suspiciousRows = rows.filter((row) =>
      isSuspiciousDiagnostic(row?.diagnostic)
    );

    if (releasedRows.length) {
      affected.push({
        userId: audit.user.id,
        name: audit.user.name,
        email: audit.user.email || "",
        services: releasedRows.map((row) => ({
          serviceKey: row.serviceKey,
          diagnostic: row.diagnostic,
          subscriptionStatus: row.subscription?.status || "",
          cycleBillingStatus: row.cycle?.billing?.status || "",
          cycleLifecycleStatus: row.cycle?.lifecycle?.planStatus || "",
          releasedFixedSchedules: row.releasedFixedSchedules.length,
          cancelledAppointments: row.cancelledAppointments.length,
        })),
      });
    }

    if (suspiciousRows.length) {
      suspicious.push({
        userId: audit.user.id,
        name: audit.user.name,
        email: audit.user.email || "",
        services: suspiciousRows.map((row) => ({
          serviceKey: row.serviceKey,
          diagnostic: row.diagnostic,
          subscriptionStatus: row.subscription?.status || "",
          cycleBillingStatus: row.cycle?.billing?.status || "",
          paidOrders: row.paidOrders.map((order) => ({
            id: order.id,
            paidAt: order.paidAt || order.createdAt || null,
            total: order.total,
            payMethod: order.payMethod,
          })),
          releasedFixedSchedules: row.releasedFixedSchedules.length,
        })),
      });
    }
  }

  return { affected, suspicious };
}

function printEmailSummary(summary = {}) {
  console.log("\n" + "#".repeat(90));
  console.log("EMAILS / USUARIOS AFECTADOS POR SUSPENSIÓN O BAJA");
  console.log("#".repeat(90));

  if (!summary.affected?.length) {
    console.log("No se encontraron usuarios con suspensión/baja/turnos liberados en el período.");
  } else {
    for (const row of summary.affected) {
      const services = row.services
        .map((service) => `${service.serviceKey}:${service.subscriptionStatus || service.diagnostic}`)
        .join(", ");
      console.log(`- ${row.email || "(sin email)"} | ${row.name || "Sin nombre"} | ${services}`);
    }
  }

  console.log("\n" + "!".repeat(90));
  console.log("INCONSISTENCIAS PRIORITARIAS: ORDEN PAGA + CICLO IMPAGO / PLAN BLOQUEADO");
  console.log("!".repeat(90));

  if (!summary.suspicious?.length) {
    console.log("No se encontraron inconsistencias de pago de este tipo.");
  } else {
    for (const row of summary.suspicious) {
      const services = row.services
        .map((service) => `${service.serviceKey}:${service.diagnostic}`)
        .join(", ");
      console.log(`- ${row.email || "(sin email)"} | ${row.name || "Sin nombre"} | ${services}`);
    }
  }
}


async function auditUser(user, periodKey, bounds) {
  const [subscriptions, cycles, schedules, appointments, orders] = await Promise.all([
    ServiceSubscription.find({ user: user._id }).lean(),
    SubscriptionBillingCycle.find({ user: user._id, periodKey }).lean(),
    FixedSchedule.find({ user: user._id }).sort({ serviceKey: 1, createdAt: 1 }).lean(),
    Appointment.find({
      user: user._id,
      fixedScheduleId: { $ne: null },
      $or: [
        { date: { $gte: bounds.startYmd, $lte: bounds.endYmd } },
        { status: "cancelled", cancelledAt: { $gte: bounds.startDate, $lte: bounds.endDate } },
      ],
    }).sort({ date: 1, time: 1 }).lean(),
    Order.find({
      user: user._id,
      status: { $in: ["paid", "approved"] },
      $or: [
        { paidAt: { $gte: bounds.startDate, $lte: bounds.endDate } },
        { paidAt: null, createdAt: { $gte: bounds.startDate, $lte: bounds.endDate } },
      ],
    }).sort({ paidAt: 1, createdAt: 1 }).lean(),
  ]);

  const released = schedules.filter(
    (s) => s.active === false && clean(s.lastAutoReleasedMonthKey) === periodKey
  );
  const cancelled = appointments.filter(
    (a) => a.status === "cancelled" && cancelledByNonPayment(a)
  );

  const services = new Set([
    ...subscriptions.map((x) => sk(x.serviceKey)),
    ...cycles.map((x) => sk(x.serviceKey)),
    ...released.map((x) => sk(x.serviceKey)),
    ...cancelled.map((x) => sk(x.serviceKey)),
  ]);

  const serviceAudits = [...services].filter(Boolean).sort().map((serviceKey) => {
    const subscription = subscriptions.find((x) => sk(x.serviceKey) === serviceKey) || null;
    const cycle = cycles.find((x) => sk(x.serviceKey) === serviceKey) || null;
    const paidOrders = orders
      .map((order) => ({ order, items: orderItems(order).filter((it) => it.serviceKey === serviceKey) }))
      .filter((row) => row.items.length);
    const releasedSchedules = released.filter((x) => sk(x.serviceKey) === serviceKey);
    const cancelledAppointments = cancelled.filter((x) => sk(x.serviceKey) === serviceKey);

    const cycleStatus = clean(cycle?.billing?.status).toLowerCase();
    const subStatus = clean(subscription?.status).toLowerCase();
    let diagnostic = releasedSchedules.length ? "FIXED_SCHEDULE_RELEASE_CONFIRMED" : "OK_OR_NO_RELEASE";
    if (paidOrders.length && subStatus === "terminated_for_non_payment") diagnostic = "TERMINATED_DESPITE_PAID_ORDER";
    else if (paidOrders.length && subStatus === "suspended") diagnostic = "SUSPENDED_DESPITE_PAID_ORDER";
    else if (paidOrders.length && ["pending", "overdue"].includes(cycleStatus)) diagnostic = "PAID_ORDER_BUT_CYCLE_UNPAID";

    const cycleFixedIds = new Set((cycle?.planSnapshot?.fixedScheduleIds || []).map(String));

    return {
      serviceKey,
      diagnostic,
      subscription: subscription ? {
        id: idOf(subscription), status: subscription.status, autoRenew: subscription.autoRenew,
        monthlySessions: subscription.monthlySessions, price: subscription.price, payMethod: subscription.payMethod,
        currentPeriodKey: subscription.currentPeriodKey, fixedScheduleIds: (subscription.fixedScheduleIds || []).map(String),
        suspendedAt: subscription.suspendedAt, suspensionReason: subscription.suspensionReason,
        terminatedAt: subscription.terminatedAt, terminationReason: subscription.terminationReason,
      } : null,
      cycle: cycle ? {
        id: idOf(cycle), periodKey: cycle.periodKey,
        billing: cycle.billing,
        lifecycle: cycle.lifecycle,
        planSnapshot: cycle.planSnapshot,
      } : null,
      paidOrders: paidOrders.map(({ order, items }) => ({
        id: idOf(order), status: order.status, paidAt: order.paidAt, createdAt: order.createdAt,
        total: Number(order.totalFinal ?? order.total ?? order.price ?? 0), payMethod: order.payMethod,
        applied: order.applied, subscriptionCycleApplied: order.subscriptionCycleApplied, matchingItems: items,
      })),
      releasedFixedSchedules: releasedSchedules.map((s) => ({
        id: idOf(s), active: s.active, items: s.items, startDate: s.startDate, endDate: s.endDate,
        lastAutoReleasedMonthKey: s.lastAutoReleasedMonthKey, deactivatedAt: s.deactivatedAt,
        preservedInCycleSnapshot: cycleFixedIds.has(idOf(s)),
      })),
      cancelledAppointments: cancelledAppointments.map((a) => ({
        id: idOf(a), date: a.date, time: a.time, fixedScheduleId: idOf(a.fixedScheduleId),
        cancelReason: a.cancelReason, cancelledAt: a.cancelledAt,
      })),
      reconstructable: releasedSchedules.length > 0 || cycleFixedIds.size > 0 || cancelledAppointments.length > 0,
    };
  });

  return {
    user: { id: idOf(user), name: [user.name, user.lastName].filter(Boolean).join(" "), email: user.email },
    periodKey,
    serviceAudits,
  };
}

function printAudit(audit) {
  console.log("\n" + "=".repeat(90));
  console.log(`${audit.user.name || "Usuario"} <${audit.user.email || "sin email"}>`);
  console.log(`USER ID: ${audit.user.id} | PERÍODO: ${audit.periodKey}`);
  console.log("=".repeat(90));

  for (const row of audit.serviceAudits) {
    console.log(`\n[${row.serviceKey}] ${row.diagnostic}`);
    console.log(`  Suscripción: ${row.subscription?.status || "no encontrada"}`);
    console.log(`  Ciclo: billing=${row.cycle?.billing?.status || "-"} | lifecycle=${row.cycle?.lifecycle?.planStatus || "-"}`);

    if (row.paidOrders.length) {
      console.log("  Órdenes pagas del período:");
      for (const o of row.paidOrders) {
        console.log(`    - ${o.id} | ${o.paidAt || o.createdAt} | $${o.total} | ${o.payMethod}`);
      }
    }

    if (row.releasedFixedSchedules.length) {
      console.log("  Turnos fijos desactivados automáticamente:");
      for (const f of row.releasedFixedSchedules) {
        const slots = (f.items || []).map((it) => `${it.weekday}@${it.time}`).join(", ");
        console.log(`    - ${f.id} | ${slots} | release=${f.lastAutoReleasedMonthKey} | deactivated=${f.deactivatedAt || "-"}`);
        console.log(`      Snapshot ciclo conserva ID: ${f.preservedInCycleSnapshot ? "SÍ" : "NO"}`);
      }
    }

    if (row.cancelledAppointments.length) {
      console.log("  Appointments cancelados por falta de pago:");
      for (const a of row.cancelledAppointments) {
        console.log(`    - ${a.date} ${a.time} | fixed=${a.fixedScheduleId} | ${a.cancelReason}`);
      }
    }
  }
}

async function main() {
  const { selector, periodKey, all } = parseArgs();

  if (!selector && !all) {
    throw new Error(
      "Indicá email/userId o usá --all. Ej: node scripts/auditReleasedFixedSchedules.js --period=2026-09 --all"
    );
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Falta MONGO_URI en .env");

  await mongoose.connect(uri);

  try {
    const bounds = periodBounds(periodKey);

    let users = [];

    if (selector) {
      const user = await findUser(selector);
      if (!user) throw new Error(`Usuario no encontrado: ${selector}`);
      users = [user];
    } else {
      users = await findUsersToAudit(periodKey);
    }

    if (!users.length) {
      console.log(`No se encontraron usuarios para auditar en ${periodKey}.`);
      return;
    }

    const audits = [];

    for (const user of users) {
      const audit = await auditUser(user, periodKey, bounds);
      audits.push(audit);

      // Con --all imprimimos el detalle solamente si hay algo relevante.
      const relevant = audit.serviceAudits.some((row) =>
        row.releasedFixedSchedules.length > 0 ||
        row.cancelledAppointments.length > 0 ||
        isSuspiciousDiagnostic(row.diagnostic) ||
        ["suspended", "terminated_for_non_payment"].includes(
          clean(row?.subscription?.status).toLowerCase()
        )
      );

      if (!all || relevant) {
        printAudit(audit);
      }
    }

    const summary = auditSummary(audits);
    printEmailSummary(summary);

    const outDir = path.resolve(process.cwd(), "backups", "subscription-audits");
    fs.mkdirSync(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(
      outDir,
      `released-fixed-${periodKey}-${stamp}.json`
    );

    const output = {
      readOnly: true,
      generatedAt: new Date().toISOString(),
      periodKey,
      mode: all ? "all" : "single-user",
      selector: selector || null,
      summary: {
        usersAudited: audits.length,
        affectedUsers: summary.affected.length,
        suspiciousPaymentMismatchUsers: summary.suspicious.length,
        affected: summary.affected,
        suspicious: summary.suspicious,
      },
      audits,
    };

    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    console.log("\n" + "=".repeat(90));
    console.log(`Usuarios auditados: ${audits.length}`);
    console.log(`Usuarios afectados: ${summary.affected.length}`);
    console.log(
      `Inconsistencias orden paga / ciclo impago: ${summary.suspicious.length}`
    );
    console.log(`Reporte JSON: ${outPath}`);
    console.log("SOLO LECTURA: no se modificó ningún dato.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (err) => {
  console.error("AUDIT ERROR:", err?.stack || err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
