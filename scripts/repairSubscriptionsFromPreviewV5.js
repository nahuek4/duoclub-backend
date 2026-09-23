// scripts/repairSubscriptionsFromPreviewV5.js
// Reparación controlada de usuarios afectados por la baja automática del día 21.
//
// SEGURIDAD:
// - por defecto es DRY RUN;
// - requiere un preview V5 reciente;
// - solo toma filas READY_FOR_APPLY;
// - vuelve a validar cupos actuales y turnos fijos antes de escribir;
// - crea backup JSON completo antes de modificar;
// - usa una transacción por usuario/servicio;
// - es idempotente: si una fila ya fue reparada, la saltea.
//
// USO:
//   node scripts/previewSubscriptionRepairV5.js --period=2026-09
//   node scripts/repairSubscriptionsFromPreviewV5.js --period=2026-09
//   node scripts/repairSubscriptionsFromPreviewV5.js --period=2026-09 --apply
//
// Opcional:
//   --report=/ruta/al/reporte.json
//   --max-age-minutes=10

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
import SubscriptionLifecycleNotice from "../src/models/SubscriptionLifecycleNotice.js";

import {
  capacityGroupForService,
  ensureServiceCatalogLoaded,
  normalizeCatalogServiceKey,
} from "../src/services/serviceCatalogRuntime.js";

const TZ = "America/Argentina/Buenos_Aires";

function clean(value) {
  return String(value ?? "").trim();
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function asInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function serviceKey(value) {
  return normalizeCatalogServiceKey(value);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function arParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function currentPeriodKey() {
  const p = arParts();
  return `${p.year}-${pad2(p.month)}`;
}

function parseArgs() {
  let periodKey = currentPeriodKey();
  let reportPath = "";
  let apply = false;
  let maxAgeMinutes = 10;

  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg.startsWith("--period=")) {
      periodKey = clean(arg.slice("--period=".length));
    } else if (arg.startsWith("--report=")) {
      reportPath = clean(arg.slice("--report=".length));
    } else if (arg.startsWith("--max-age-minutes=")) {
      maxAgeMinutes = Math.max(
        1,
        Math.min(
          120,
          Number(arg.slice("--max-age-minutes=".length)) || 10
        )
      );
    }
  }

  return {
    periodKey,
    reportPath,
    apply,
    maxAgeMinutes,
  };
}

function periodBounds(periodKey) {
  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    throw new Error(`Período inválido: ${periodKey}`);
  }

  const [year, month] = periodKey.split("-").map(Number);
  const lastDay = new Date(year, month, 0, 12, 0, 0).getDate();

  return {
    startYmd: `${periodKey}-01`,
    endYmd: `${periodKey}-${pad2(lastDay)}`,
  };
}

function newestPreviewReport(periodKey) {
  const dir = path.resolve(
    process.cwd(),
    "backups",
    "subscription-audits"
  );

  if (!fs.existsSync(dir)) {
    throw new Error(
      `No existe ${dir}. Corré primero previewSubscriptionRepairV5.js.`
    );
  }

  const prefix = `repair-preview-v5-${periodKey}-`;

  const files = fs
    .readdirSync(dir)
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith(".json")
    )
    .map((name) => ({
      name,
      fullPath: path.join(dir, name),
      mtime: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) {
    throw new Error(
      `No encontré preview V5 para ${periodKey}. Corré primero: node scripts/previewSubscriptionRepairV5.js --period=${periodKey}`
    );
  }

  return files[0].fullPath;
}

function readReport(reportPath, periodKey, maxAgeMinutes) {
  const raw = fs.readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw);

  if (clean(report?.periodKey) !== periodKey) {
    throw new Error(
      `El reporte es de ${report?.periodKey || "otro período"}, no ${periodKey}.`
    );
  }

  const generatedAt = new Date(report?.generatedAt || 0);
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error("El reporte no tiene generatedAt válido.");
  }

  const ageMs = Date.now() - generatedAt.getTime();
  const maxAgeMs = maxAgeMinutes * 60 * 1000;

  if (ageMs > maxAgeMs) {
    throw new Error(
      `El preview tiene ${Math.round(
        ageMs / 60000
      )} minutos. Volvé a correr V5 antes de aplicar (máximo ${maxAgeMinutes} min).`
    );
  }

  const rows = (Array.isArray(report?.rows) ? report.rows : []).filter(
    (row) => clean(row?.decision) === "READY_FOR_APPLY"
  );

  if (!rows.length) {
    throw new Error("El reporte no contiene filas READY_FOR_APPLY.");
  }

  for (const row of rows) {
    if (!row?.paymentLedgerPreview?.fullyPaid) {
      throw new Error(
        `Fila READY sin pago completo: ${row?.user?.email} ${row?.serviceKey}`
      );
    }

    if (Number(row?.unsafeClaimsCount || 0) !== 0) {
      throw new Error(
        `Fila READY con conflictos: ${row?.user?.email} ${row?.serviceKey}`
      );
    }

    if (!(money(row?.paymentLedgerPreview?.expectedPlanAmount) > 0)) {
      throw new Error(
        `Fila READY sin importe histórico válido: ${row?.user?.email} ${row?.serviceKey}`
      );
    }

    const cycleSessions = asInt(row?.historicalPlanIdentity?.cycleSessions);
    const grantedSessions = asInt(
      row?.historicalPlanIdentity?.creditGrantSessions
    );

    if (!(cycleSessions > 0)) {
      throw new Error(
        `Fila READY sin sesiones históricas del ciclo: ${row?.user?.email} ${row?.serviceKey}`
      );
    }

    if (grantedSessions > 0 && cycleSessions !== grantedSessions) {
      throw new Error(
        `Inconsistencia ciclo/créditos: ${row?.user?.email} ${row?.serviceKey} cycle=${cycleSessions} granted=${grantedSessions}`
      );
    }

    const source = clean(
      row?.paymentLedgerPreview?.authoritativeAmountSource
    );

    if (
      source.startsWith("HISTORICAL_COHORT_CONSENSUS:") &&
      !source.includes(`|${cycleSessions}|`)
    ) {
      throw new Error(
        `Consenso histórico pertenece a otro plan: ${row?.user?.email} ${row?.serviceKey}`
      );
    }
  }

  return { report, rows, generatedAt };
}

function appointmentZone(ap) {
  return (
    clean(
      capacityGroupForService(
        serviceKey(ap?.serviceKey || ap?.service)
      )
    ).toUpperCase() || "NONE"
  );
}

function claimZone(claim) {
  return (
    clean(
      claim?.capacity?.zone ||
        capacityGroupForService(claim?.serviceKey)
    ).toUpperCase() || "NONE"
  );
}

async function validateAppointmentCapacity(rows) {
  const claims = rows.flatMap((row) =>
    (Array.isArray(row?.claims) ? row.claims : []).map(
      (claim) => ({
        ...claim,
        rowEmail: row?.user?.email || "",
      })
    )
  );

  const grouped = new Map();

  for (const claim of claims) {
    const key = `${claim.date}|${claim.time}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(claim);
  }

  const errors = [];

  for (const [slotKey, slotClaims] of grouped.entries()) {
    const [date, time] = slotKey.split("|");

    const existing = await Appointment.find({
      date,
      time,
      status: "reserved",
    })
      .select(
        "user serviceKey service fixedScheduleId date time status"
      )
      .lean();

    for (const claim of slotClaims) {
      const alreadyBySameUser = existing.find(
        (ap) =>
          String(ap?.user || "") ===
          String(claim?.userId || "")
      );

      if (alreadyBySameUser) {
        errors.push({
          type: "USER_ALREADY_RESERVED",
          date,
          time,
          email: claim.rowEmail,
          appointmentId: String(alreadyBySameUser._id),
        });
        continue;
      }

      const zone = claimZone(claim);
      const sk = serviceKey(claim.serviceKey);

      const batchSameZone = slotClaims.filter(
        (other) => claimZone(other) === zone
      ).length;

      const batchSameService = slotClaims.filter(
        (other) => serviceKey(other.serviceKey) === sk
      ).length;

      const zoneReservedNow =
        zone === "NONE"
          ? existing.filter(
              (ap) =>
                serviceKey(ap?.serviceKey || ap?.service) ===
                sk
            ).length
          : existing.filter(
              (ap) => appointmentZone(ap) === zone
            ).length;

      const serviceReservedNow = existing.filter(
        (ap) =>
          serviceKey(ap?.serviceKey || ap?.service) === sk
      ).length;

      const zoneLimit = Number(
        claim?.capacity?.zoneLimit ??
          claim?.batchSimulation?.zoneLimit ??
          0
      );

      const serviceLimitRaw =
        claim?.capacity?.serviceLimit ??
        claim?.batchSimulation?.serviceLimit ??
        null;

      const serviceLimit =
        serviceLimitRaw === null ||
        serviceLimitRaw === undefined
          ? null
          : Number(serviceLimitRaw);

      if (
        zoneLimit > 0 &&
        zoneReservedNow + batchSameZone > zoneLimit
      ) {
        errors.push({
          type: "ZONE_CAPACITY_CHANGED",
          date,
          time,
          zone,
          zoneReservedNow,
          batchSameZone,
          zoneLimit,
          email: claim.rowEmail,
        });
      }

      if (
        serviceLimit !== null &&
        serviceLimit >= 0 &&
        serviceReservedNow + batchSameService >
          serviceLimit
      ) {
        errors.push({
          type: "SERVICE_CAPACITY_CHANGED",
          date,
          time,
          serviceKey: sk,
          serviceReservedNow,
          batchSameService,
          serviceLimit,
          email: claim.rowEmail,
        });
      }
    }
  }

  return errors;
}

function fixedSlotKey(serviceKeyValue, weekday, time) {
  const zone =
    clean(
      capacityGroupForService(serviceKey(serviceKeyValue))
    ).toUpperCase() || "NONE";

  return `${zone}|${Number(weekday)}|${clean(time).slice(
    0,
    5
  )}`;
}

async function validateFixedScheduleCapacity(rows) {
  const activeSchedules = await FixedSchedule.find({
    active: true,
  })
    .select("serviceKey items")
    .lean();

  const activeCounts = new Map();

  for (const schedule of activeSchedules) {
    for (const item of Array.isArray(schedule?.items)
      ? schedule.items
      : []) {
      const key = fixedSlotKey(
        schedule.serviceKey,
        item.weekday,
        item.time
      );
      activeCounts.set(key, (activeCounts.get(key) || 0) + 1);
    }
  }

  const restoreCounts = new Map();
  const metaByKey = new Map();

  for (const row of rows) {
    for (const schedule of Array.isArray(
      row?.releasedFixedSchedules
    )
      ? row.releasedFixedSchedules
      : []) {
      for (const item of Array.isArray(schedule?.items)
        ? schedule.items
        : []) {
        const key = fixedSlotKey(
          row.serviceKey,
          item.weekday,
          item.time
        );

        restoreCounts.set(
          key,
          (restoreCounts.get(key) || 0) + 1
        );

        if (!metaByKey.has(key)) {
          const claim = (row.claims || []).find(
            (candidate) =>
              String(candidate.fixedScheduleId) ===
                String(schedule.fixedScheduleId) &&
              clean(candidate.time).slice(0, 5) ===
                clean(item.time).slice(0, 5)
          );

          metaByKey.set(key, {
            email: row?.user?.email || "",
            serviceKey: row.serviceKey,
            weekday: item.weekday,
            time: item.time,
            zoneLimit: Number(
              claim?.capacity?.zoneLimit ??
                claim?.batchSimulation?.zoneLimit ??
                0
            ),
          });
        }
      }
    }
  }

  const errors = [];

  for (const [key, restoreCount] of restoreCounts.entries()) {
    const current = activeCounts.get(key) || 0;
    const meta = metaByKey.get(key) || {};
    const limit = Number(meta.zoneLimit || 0);

    if (limit > 0 && current + restoreCount > limit) {
      errors.push({
        type: "FIXED_SCHEDULE_CAPACITY_CHANGED",
        key,
        currentActiveFixedSlots: current,
        restoringFixedSlots: restoreCount,
        limit,
        ...meta,
      });
    }
  }

  return errors;
}

async function validateCurrentDocuments(rows, periodKey) {
  const errors = [];

  for (const row of rows) {
    const [subscription, cycle] = await Promise.all([
      ServiceSubscription.findById(
        row.subscription.id
      ).lean(),
      SubscriptionBillingCycle.findById(row.cycle.id).lean(),
    ]);

    if (!subscription) {
      errors.push({
        type: "SUBSCRIPTION_MISSING",
        email: row.user.email,
        serviceKey: row.serviceKey,
      });
      continue;
    }

    if (!cycle) {
      errors.push({
        type: "CYCLE_MISSING",
        email: row.user.email,
        serviceKey: row.serviceKey,
      });
      continue;
    }

    const reportCycleSessions = asInt(
      row?.historicalPlanIdentity?.cycleSessions
    );
    const liveCycleSessions = asInt(
      cycle?.planSnapshot?.monthlySessions
    );

    if (
      reportCycleSessions > 0 &&
      liveCycleSessions !== reportCycleSessions
    ) {
      errors.push({
        type: "CYCLE_HISTORICAL_SESSIONS_CHANGED",
        email: row.user.email,
        serviceKey: row.serviceKey,
        reportCycleSessions,
        liveCycleSessions,
      });
    }

    // Si ya quedó reparado, lo dejamos como idempotente y no lo
    // consideramos error.
    const alreadyRepaired =
      String(subscription.status) === "active" &&
      String(cycle.billing?.status) === "paid" &&
      String(cycle.lifecycle?.planStatus) === "active";

    if (alreadyRepaired) continue;

    if (
      !["suspended", "terminated_for_non_payment"].includes(
        String(subscription.status || "")
      )
    ) {
      errors.push({
        type: "SUBSCRIPTION_STATE_CHANGED",
        email: row.user.email,
        serviceKey: row.serviceKey,
        status: subscription.status,
      });
    }

    if (
      !["pending", "overdue"].includes(
        String(cycle.billing?.status || "")
      )
    ) {
      errors.push({
        type: "CYCLE_BILLING_STATE_CHANGED",
        email: row.user.email,
        serviceKey: row.serviceKey,
        status: cycle.billing?.status,
      });
    }

    if (String(cycle.periodKey) !== periodKey) {
      errors.push({
        type: "CYCLE_PERIOD_CHANGED",
        email: row.user.email,
        serviceKey: row.serviceKey,
        cyclePeriodKey: cycle.periodKey,
      });
    }

    for (const claim of row.claims || []) {
      const ap = await Appointment.findById(
        claim.targetAppointmentId
      ).lean();

      if (!ap) {
        errors.push({
          type: "APPOINTMENT_MISSING",
          email: row.user.email,
          appointmentId: claim.targetAppointmentId,
        });
        continue;
      }

      if (
        String(ap.status) !== "cancelled" ||
        !/falta de pago|plan mensual/i.test(
          clean(ap.cancelReason)
        )
      ) {
        errors.push({
          type: "APPOINTMENT_STATE_CHANGED",
          email: row.user.email,
          appointmentId: claim.targetAppointmentId,
          status: ap.status,
          cancelReason: ap.cancelReason,
        });
      }
    }
  }

  return errors;
}

async function createBackup({
  rows,
  periodKey,
  reportPath,
}) {
  const userIds = [
    ...new Set(rows.map((row) => row.user.id)),
  ];

  const subscriptionIds = [
    ...new Set(rows.map((row) => row.subscription.id)),
  ];

  const cycleIds = [
    ...new Set(rows.map((row) => row.cycle.id)),
  ];

  const fixedScheduleIds = [
    ...new Set(
      rows.flatMap((row) =>
        (row.releasedFixedSchedules || []).map(
          (schedule) => schedule.fixedScheduleId
        )
      )
    ),
  ];

  const appointmentIds = [
    ...new Set(
      rows.flatMap((row) =>
        (row.claims || [])
          .map((claim) => claim.targetAppointmentId)
          .filter(Boolean)
      )
    ),
  ];

  const orderIds = [
    ...new Set(
      rows.flatMap((row) =>
        (
          row.paymentLedgerPreview?.compatiblePayments ||
          []
        )
          .map((payment) => payment.orderId)
          .filter(Boolean)
      )
    ),
  ];

  const [
    users,
    subscriptions,
    cycles,
    fixedSchedules,
    appointments,
    notices,
    orders,
  ] = await Promise.all([
    User.find({ _id: { $in: userIds } }).lean(),
    ServiceSubscription.find({
      _id: { $in: subscriptionIds },
    }).lean(),
    SubscriptionBillingCycle.find({
      _id: { $in: cycleIds },
    }).lean(),
    FixedSchedule.find({
      _id: { $in: fixedScheduleIds },
    }).lean(),
    Appointment.find({
      _id: { $in: appointmentIds },
    }).lean(),
    SubscriptionLifecycleNotice.find({
      subscription: { $in: subscriptionIds },
      periodKey,
    }).lean(),
    orderIds.length
      ? Order.find({ _id: { $in: orderIds } }).lean()
      : [],
  ]);

  const backup = {
    generatedAt: new Date().toISOString(),
    periodKey,
    reportPath,
    rows: rows.map((row) => ({
      user: row.user,
      serviceKey: row.serviceKey,
      subscriptionId: row.subscription.id,
      cycleId: row.cycle.id,
      fixedScheduleIds: (
        row.releasedFixedSchedules || []
      ).map((item) => item.fixedScheduleId),
      appointmentIds: (row.claims || []).map(
        (item) => item.targetAppointmentId
      ),
    })),
    users,
    subscriptions,
    cycles,
    fixedSchedules,
    appointments,
    notices,
    orders,
  };

  const dir = path.resolve(
    process.cwd(),
    "backups",
    "subscription-repairs"
  );

  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const filePath = path.join(
    dir,
    `before-repair-${periodKey}-${stamp}.json`
  );

  fs.writeFileSync(
    filePath,
    JSON.stringify(backup, null, 2),
    "utf8"
  );

  return filePath;
}

function mergeHistoricalPayments(cycle, row) {
  const total = money(
    row?.paymentLedgerPreview?.expectedPlanAmount
  );

  const compatible = [
    ...(row?.paymentLedgerPreview?.compatiblePayments || []),
  ].sort(
    (a, b) =>
      new Date(a?.paidAt || 0).getTime() -
      new Date(b?.paidAt || 0).getTime()
  );

  const existing = Array.isArray(cycle.billing?.payments)
    ? cycle.billing.payments
    : [];

  const existingOrderIds = new Set(
    existing.map((payment) => idOf(payment?.order)).filter(Boolean)
  );

  let remaining = total;
  const historical = [];

  for (const payment of compatible) {
    const amount = money(payment?.amount);
    if (!(amount > 0)) continue;

    const appliedAmount = Math.min(amount, remaining);
    const excessAmount = Math.max(0, amount - appliedAmount);
    remaining = Math.max(0, remaining - appliedAmount);

    if (!existingOrderIds.has(clean(payment.orderId))) {
      historical.push({
        order:
          mongoose.Types.ObjectId.isValid(
            clean(payment.orderId)
          )
            ? payment.orderId
            : null,
        amount,
        appliedAmount,
        excessAmount,
        paidAt: payment?.paidAt
          ? new Date(payment.paidAt)
          : new Date(),
        paymentProvider: clean(payment?.payMethod),
        paymentId: "",
        note:
          "Pago histórico reconstruido por reparación septiembre 2026.",
      });
    }
  }

  cycle.billing.payments = [
    ...existing,
    ...historical,
  ];

  const amountReceived = compatible.reduce(
    (sum, payment) => sum + money(payment?.amount),
    0
  );

  let paidAt = null;
  let cumulative = 0;

  for (const payment of compatible) {
    cumulative += money(payment?.amount);

    if (!paidAt && cumulative >= total) {
      paidAt = payment?.paidAt
        ? new Date(payment.paidAt)
        : new Date();
    }
  }

  cycle.billing.amountReceived = amountReceived;
  cycle.billing.amountPaid = total;
  cycle.billing.balanceDue = 0;
  cycle.billing.overpaidAmount = Math.max(
    0,
    amountReceived - total
  );
  cycle.billing.status = "paid";
  cycle.billing.paidAt = paidAt || new Date();
  cycle.billing.overdueAt = null;

  const lastPayment = compatible[compatible.length - 1];
  if (lastPayment) {
    cycle.billing.paymentProvider = clean(
      lastPayment.payMethod
    );

    if (
      mongoose.Types.ObjectId.isValid(
        clean(lastPayment.orderId)
      )
    ) {
      cycle.billing.order = lastPayment.orderId;
    }
  }

  return {
    total,
    amountReceived,
    overpaidAmount: cycle.billing.overpaidAmount,
    paidAt: cycle.billing.paidAt,
  };
}

function isLifecycleCancellation(ap) {
  return (
    String(ap?.status || "") === "cancelled" &&
    /falta de pago|plan mensual/i.test(
      clean(ap?.cancelReason)
    )
  );
}

function recalcUserCredits(user, now = new Date()) {
  const lots = Array.isArray(user?.creditLots)
    ? user.creditLots
    : [];

  user.credits = lots.reduce((sum, lot) => {
    const expiresAt = lot?.expiresAt
      ? new Date(lot.expiresAt)
      : null;

    if (expiresAt && expiresAt <= now) return sum;

    return sum + Math.max(0, Number(lot?.remaining || 0));
  }, 0);
}

async function restoreCreditLot({
  user,
  cycle,
  session,
  now,
}) {
  const lotId = cycle?.creditGrant?.lotId;

  if (!lotId) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_CYCLE_LOT",
    };
  }

  const lot = user.creditLots?.id?.(lotId);

  if (!lot) {
    throw new Error(
      `CYCLE_CREDIT_LOT_NOT_FOUND:${String(lotId)}`
    );
  }

  const linkedAppointments = await Appointment.find({
    user: user._id,
    creditLotId: lot._id,
  }).session(session);

  let consumed = 0;

  for (const ap of linkedAppointments) {
    const status = String(ap.status || "");

    if (status === "reserved" || status === "completed") {
      consumed += 1;
      continue;
    }

    if (
      status === "cancelled" &&
      ap.refundApplied !== true &&
      !isLifecycleCancellation(ap)
    ) {
      consumed += 1;
    }
  }

  const amount = Math.max(
    0,
    Number(lot.amount || cycle.creditGrant?.grantedSessions || 0)
  );

  lot.remaining = Math.max(0, amount - consumed);

  cycle.creditGrant.invalidatedAt = null;
  cycle.creditGrant.invalidationReason = "";

  recalcUserCredits(user, now);

  return {
    ok: true,
    lotId: String(lot._id),
    amount,
    consumed,
    remaining: Number(lot.remaining || 0),
  };
}

async function rowAlreadyRepaired(row, session) {
  const [subscription, cycle] = await Promise.all([
    ServiceSubscription.findById(
      row.subscription.id
    ).session(session),
    SubscriptionBillingCycle.findById(
      row.cycle.id
    ).session(session),
  ]);

  return Boolean(
    subscription &&
      cycle &&
      subscription.status === "active" &&
      cycle.billing?.status === "paid" &&
      cycle.lifecycle?.planStatus === "active"
  );
}

async function repairRow({
  row,
  periodKey,
  now,
}) {
  const session = await mongoose.startSession();
  let output = null;

  try {
    await session.withTransaction(async () => {
      if (await rowAlreadyRepaired(row, session)) {
        output = {
          ok: true,
          skipped: true,
          reason: "ALREADY_REPAIRED",
          email: row.user.email,
          serviceKey: row.serviceKey,
        };
        return;
      }

      const [user, subscription, cycle] =
        await Promise.all([
          User.findById(row.user.id).session(session),
          ServiceSubscription.findById(
            row.subscription.id
          ).session(session),
          SubscriptionBillingCycle.findById(
            row.cycle.id
          ).session(session),
        ]);

      if (!user) throw new Error("USER_NOT_FOUND");
      if (!subscription) {
        throw new Error("SUBSCRIPTION_NOT_FOUND");
      }
      if (!cycle) throw new Error("CYCLE_NOT_FOUND");

      const reportCycleSessions = asInt(
        row?.historicalPlanIdentity?.cycleSessions
      );
      const liveCycleSessions = asInt(
        cycle?.planSnapshot?.monthlySessions
      );

      if (
        !(reportCycleSessions > 0) ||
        liveCycleSessions !== reportCycleSessions
      ) {
        throw new Error(
          `HISTORICAL_PLAN_IDENTITY_CHANGED:report=${reportCycleSessions}:live=${liveCycleSessions}`
        );
      }

      const expectedTotal = money(
        row.paymentLedgerPreview?.expectedPlanAmount
      );

      if (!(expectedTotal > 0)) {
        throw new Error(
          "INVALID_HISTORICAL_PLAN_AMOUNT"
        );
      }

      const addOns = money(cycle.billing?.amountAddOns);
      const extras = money(cycle.billing?.amountExtras);
      const reconstructedBase = Math.max(
        0,
        expectedTotal - addOns - extras
      );

      cycle.billing.total = expectedTotal;
      cycle.billing.amountBase = reconstructedBase;

      if (cycle.planSnapshot) {
        cycle.planSnapshot.basePrice = reconstructedBase;

        if (!cycle.planSnapshot.coverageApplied) {
          cycle.planSnapshot.regularPrice =
            reconstructedBase;
        }
      }

      const paymentResult = mergeHistoricalPayments(
        cycle,
        row
      );

      cycle.lifecycle.planStatus = "active";
      cycle.lifecycle.suspendedAt = null;
      cycle.lifecycle.terminatedAt = null;
      cycle.lifecycle.terminationReason = "";

      const fixedScheduleIds = (
        row.releasedFixedSchedules || []
      )
        .map((item) => item.fixedScheduleId)
        .filter(
          (id) => mongoose.Types.ObjectId.isValid(id)
        );

      const schedules = await FixedSchedule.find({
        _id: { $in: fixedScheduleIds },
        user: user._id,
        serviceKey: serviceKey(row.serviceKey),
      }).session(session);

      if (
        schedules.length !==
        fixedScheduleIds.length
      ) {
        throw new Error(
          "RELEASED_FIXED_SCHEDULE_COUNT_CHANGED"
        );
      }

      for (const schedule of schedules) {
        schedule.active = true;
        schedule.deactivatedAt = null;
        await schedule.save({ session });
      }

      subscription.status = "active";
      subscription.autoRenew = true;
      subscription.suspendedAt = null;
      subscription.suspensionReason = "";
      subscription.terminatedAt = null;
      subscription.terminationReason = "";
      subscription.fixedScheduleIds =
        schedules.map((item) => item._id);

      subscription.price = reconstructedBase;

      if (!cycle.planSnapshot?.coverageApplied) {
        subscription.regularPrice =
          reconstructedBase;
      }

      const appointmentResults = [];

      for (const claim of row.claims || []) {
        const ap = await Appointment.findOne({
          _id: claim.targetAppointmentId,
          user: user._id,
          fixedScheduleId: claim.fixedScheduleId,
          serviceKey: serviceKey(row.serviceKey),
        }).session(session);

        if (!ap) {
          throw new Error(
            `APPOINTMENT_NOT_FOUND:${claim.targetAppointmentId}`
          );
        }

        if (
          ap.status !== "cancelled" ||
          !/falta de pago|plan mensual/i.test(
            clean(ap.cancelReason)
          )
        ) {
          throw new Error(
            `APPOINTMENT_CHANGED:${String(ap._id)}`
          );
        }

        ap.status = "reserved";
        ap.cancelledAt = null;
        ap.cancelledBy = null;
        ap.cancelReason = "";
        ap.refundApplied = false;
        ap.refundMode = "";
        ap.refundReason = "";
        ap.fixedDebtAmount = 0;

        if (ap.creditLotId) {
          ap.creditDebitStatus =
            "monthly_reserved";
          ap.fixedDebitProcessedAt =
            ap.creditDebitedAt || now;
        } else {
          ap.creditDebitStatus = "pending";
          ap.creditDebitedAt = null;
          ap.fixedDebitProcessedAt = null;
        }

        await ap.save({ session });

        appointmentResults.push({
          appointmentId: String(ap._id),
          date: ap.date,
          time: ap.time,
          creditDebitStatus:
            ap.creditDebitStatus,
        });
      }

      const creditResult = await restoreCreditLot({
        user,
        cycle,
        session,
        now,
      });

      user.history = Array.isArray(user.history)
        ? user.history
        : [];

      user.history.push({
        action:
          "subscription_repaired_after_payment_cycle_bug",
        title: `Plan ${subscription.serviceKey} reparado`,
        message:
          `Se reparó el ciclo ${periodKey} luego de verificar pagos históricos y turnos fijos liberados incorrectamente.`,
        serviceKey: subscription.serviceKey,
        serviceName:
          subscription.serviceName ||
          subscription.serviceKey,
        service:
          subscription.serviceName ||
          subscription.serviceKey,
        qty: 0,
        createdAt: now,
      });

      await user.save({ session });
      await cycle.save({ session });
      await subscription.save({ session });

      await SubscriptionLifecycleNotice.updateMany(
        {
          user: user._id,
          subscription: subscription._id,
          periodKey,
          type: {
            $in: [
              "payment_pending",
              "suspended",
              "terminated",
            ],
          },
        },
        {
          $set: {
            status: "resolved",
            resolvedAt: now,
          },
        },
        { session }
      );

      output = {
        ok: true,
        email: row.user.email,
        serviceKey: row.serviceKey,
        subscriptionId: String(subscription._id),
        cycleId: String(cycle._id),
        historicalTotal: expectedTotal,
        paymentResult,
        fixedSchedulesRestored:
          schedules.length,
        appointmentsRestored:
          appointmentResults.length,
        appointments: appointmentResults,
        creditResult,
      };
    });

    return output;
  } finally {
    await session.endSession();
  }
}

async function main() {
  const {
    periodKey,
    reportPath: explicitReport,
    apply,
    maxAgeMinutes,
  } = parseArgs();

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Falta MONGO_URI en .env");

  const reportPath = explicitReport
    ? path.resolve(explicitReport)
    : newestPreviewReport(periodKey);

  if (!fs.existsSync(reportPath)) {
    throw new Error(`No existe reporte: ${reportPath}`);
  }

  const { rows, generatedAt } = readReport(
    reportPath,
    periodKey,
    maxAgeMinutes
  );

  await mongoose.connect(uri);

  try {
    await ensureServiceCatalogLoaded({
      force: true,
    });

    console.log(
      "\n" + "=".repeat(100)
    );
    console.log(
      `REPARACIÓN ${periodKey} · ${
        apply ? "APPLY" : "DRY RUN"
      }`
    );
    console.log(`Reporte: ${reportPath}`);
    console.log(
      `Generado: ${generatedAt.toISOString()}`
    );
    console.log(
      `READY_FOR_APPLY: ${rows.length}`
    );
    console.log("=".repeat(100));

    const [
      documentErrors,
      appointmentCapacityErrors,
      fixedCapacityErrors,
    ] = await Promise.all([
      validateCurrentDocuments(rows, periodKey),
      validateAppointmentCapacity(rows),
      validateFixedScheduleCapacity(rows),
    ]);

    const allErrors = [
      ...documentErrors,
      ...appointmentCapacityErrors,
      ...fixedCapacityErrors,
    ];

    if (allErrors.length) {
      console.error(
        "\nPRECHECK FALLÓ. NO SE MODIFICA NADA."
      );

      for (const error of allErrors.slice(0, 50)) {
        console.error(
          JSON.stringify(error)
        );
      }

      if (allErrors.length > 50) {
        console.error(
          `... +${allErrors.length - 50} errores`
        );
      }

      process.exitCode = 2;
      return;
    }

    const totalAppointments = rows.reduce(
      (sum, row) =>
        sum + Number(row?.claims?.length || 0),
      0
    );

    const priceCorrections = rows.filter(
      (row) =>
        row.paymentLedgerPreview
          ?.cycleTotalNeedsCorrection
    ).length;

    console.log(
      `Precheck OK: ${rows.length} planes, ${totalAppointments} turnos futuros.`
    );
    console.log(
      `Ciclos cuyo precio histórico se corregirá: ${priceCorrections}`
    );

    if (!apply) {
      console.log(
        "\nDRY RUN: no se modificó ningún dato."
      );
      console.log(
        "Para aplicar, volvé a correr V4 y enseguida ejecutá:"
      );
      console.log(
        `node scripts/repairSubscriptionsFromPreviewV5.js --period=${periodKey} --apply`
      );
      return;
    }

    const backupPath = await createBackup({
      rows,
      periodKey,
      reportPath,
    });

    console.log(
      `\nBackup previo: ${backupPath}`
    );

    const results = [];
    const now = new Date();

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];

      process.stdout.write(
        `[${index + 1}/${rows.length}] ${
          row.user.email
        } ${row.serviceKey} ... `
      );

      try {
        const result = await repairRow({
          row,
          periodKey,
          now,
        });

        results.push(result);
        console.log(
          result?.skipped ? "SKIP" : "OK"
        );
      } catch (error) {
        console.log("ERROR");
        console.error(
          error?.stack || error?.message || error
        );

        throw new Error(
          `REPAIR_ABORTED_AT:${row.user.email}:${row.serviceKey}:${error?.message || error}`
        );
      }
    }

    const outputDir = path.resolve(
      process.cwd(),
      "backups",
      "subscription-repairs"
    );

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    const resultPath = path.join(
      outputDir,
      `repair-result-${periodKey}-${stamp}.json`
    );

    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        {
          appliedAt: new Date().toISOString(),
          periodKey,
          reportPath,
          backupPath,
          rowsRequested: rows.length,
          repaired: results.filter(
            (row) => row?.ok && !row?.skipped
          ).length,
          skipped: results.filter(
            (row) => row?.skipped
          ).length,
          results,
        },
        null,
        2
      ),
      "utf8"
    );

    console.log(
      "\n" + "=".repeat(100)
    );
    console.log("REPARACIÓN TERMINADA");
    console.log(
      `Reparados: ${
        results.filter(
          (row) => row?.ok && !row?.skipped
        ).length
      }`
    );
    console.log(
      `Ya reparados / salteados: ${
        results.filter((row) => row?.skipped)
          .length
      }`
    );
    console.log(
      `Resultado: ${resultPath}`
    );
    console.log(
      `Backup: ${backupPath}`
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(
    "\nREPAIR ERROR:",
    error?.stack || error?.message || error
  );

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
