// scripts/reconcileSafeDuplicateCreditsV1.js
//
// DUO CLUB — saneo de duplicados de créditos POST reparación.
// DRY RUN por defecto.
//
// REGLA:
// - La Order CREDITS paga es la fuente real de sesiones compradas.
// - El lote mensual del ciclo NO se suma a la Order.
// - Se migra el historial de appointments del lote duplicado al lote de la Order.
// - remaining final = sesiones compradas - consumos reales.
// - NO toca dinero, estado del plan, turnos, FixedSchedules ni lifecycle.
//
// SOLO procesa automáticamente casos que hoy cumplen TODOS:
// - subscription active;
// - cycle lifecycle active;
// - exactamente 1 Order CREDITS paga del servicio en el período;
// - exactamente 1 lote de esa Order;
// - amount del lote = credits de la Order;
// - los consumos reales NO superan las sesiones pagas;
// - existe lote generado por subscription_cycle para ese ciclo;
// - todavía NO está canonicalizado.
//
// Casos con consumos > sesiones pagas quedan REVIEW y NO se modifican.
//
// Uso:
//   node scripts/reconcileSafeDuplicateCreditsV1.js --period=2026-09
//   node scripts/reconcileSafeDuplicateCreditsV1.js --period=2026-09 --apply
//
// Opcional:
//   --service=EP
//   --only=email@dominio.com

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

function clean(v) {
  return String(v ?? "").trim();
}

function idOf(v) {
  return clean(v?._id || v?.id || v);
}

function money(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function asInt(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function parseArgs() {
  let periodKey = "2026-09";
  let serviceKey = "EP";
  let only = "";
  let apply = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg.startsWith("--period=")) {
      periodKey = clean(arg.slice("--period=".length));
    } else if (arg.startsWith("--service=")) {
      serviceKey = clean(arg.slice("--service=".length)).toUpperCase();
    } else if (arg.startsWith("--only=")) {
      only = clean(arg.slice("--only=".length)).toLowerCase();
    }
  }

  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    throw new Error(`Período inválido: ${periodKey}`);
  }

  return { periodKey, serviceKey, only, apply };
}

function periodBounds(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    startDate: new Date(`${periodKey}-01T00:00:00-03:00`),
    endDate: new Date(
      `${periodKey}-${String(lastDay).padStart(2, "0")}T23:59:59-03:00`
    ),
  };
}

function orderCredits(order, serviceKey) {
  const sk = clean(serviceKey).toUpperCase();

  const matches = (Array.isArray(order?.items) ? order.items : []).filter(
    (item) =>
      clean(item?.kind).toUpperCase() === "CREDITS" &&
      clean(item?.serviceKey).toUpperCase() === sk
  );

  if (matches.length) {
    return matches.reduce((sum, item) => {
      const qty = Math.max(1, asInt(item?.qty) || 1);
      return sum + asInt(item?.credits) * qty;
    }, 0);
  }

  if (
    clean(order?.serviceKey).toUpperCase() === sk &&
    asInt(order?.credits) > 0
  ) {
    return asInt(order.credits);
  }

  return 0;
}

function isLifecycleCancellation(ap) {
  return (
    clean(ap?.status).toLowerCase() === "cancelled" &&
    /falta de pago|plan mensual/i.test(clean(ap?.cancelReason))
  );
}

function consumesSession(ap) {
  const status = clean(ap?.status).toLowerCase();

  if (status === "reserved" || status === "completed") {
    return true;
  }

  if (
    status === "cancelled" &&
    ap?.refundApplied !== true &&
    !isLifecycleCancellation(ap)
  ) {
    return true;
  }

  return false;
}

function recalcUserCredits(user, now = new Date()) {
  user.credits = (Array.isArray(user?.creditLots) ? user.creditLots : []).reduce(
    (sum, lot) => {
      const expiresAt = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      if (expiresAt && expiresAt <= now) return sum;
      return sum + Math.max(0, Number(lot?.remaining || 0));
    },
    0
  );
}

async function queryWithSession(query, session) {
  if (session) query.session(session);
  return query;
}

async function inspectCycle({
  cycleId,
  periodKey,
  serviceKey,
  session = null,
}) {
  const cycle = await queryWithSession(
    SubscriptionBillingCycle.findById(cycleId),
    session
  );

  if (!cycle) {
    return {
      classification: "STRUCTURE_REVIEW",
      errors: ["CYCLE_NOT_FOUND"],
    };
  }

  const user = await queryWithSession(User.findById(cycle.user), session);

  if (!user) {
    return {
      cycle,
      classification: "STRUCTURE_REVIEW",
      errors: ["USER_NOT_FOUND"],
    };
  }

  const subscription = await queryWithSession(
    ServiceSubscription.findById(cycle.subscription),
    session
  );

  if (!subscription) {
    return {
      cycle,
      user,
      classification: "STRUCTURE_REVIEW",
      errors: ["SUBSCRIPTION_NOT_FOUND"],
    };
  }

  const bounds = periodBounds(periodKey);

  const orders = await queryWithSession(
    Order.find({
      user: user._id,
      status: { $in: ["paid", "approved"] },
      $or: [
        { paidAt: { $gte: bounds.startDate, $lte: bounds.endDate } },
        {
          paidAt: null,
          createdAt: { $gte: bounds.startDate, $lte: bounds.endDate },
        },
      ],
    }).sort({ paidAt: 1, createdAt: 1 }),
    session
  );

  const paidCreditOrders = orders
    .map((order) => ({
      order,
      credits: orderCredits(order, serviceKey),
    }))
    .filter((row) => row.credits > 0);

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const cycleSourcePrefix = `subscription_cycle:${String(
    cycle._id
  )}:${periodKey}`;

  const historicalCycleLots = lots.filter((lot) => {
    const source = clean(lot?.source);

    return (
      clean(lot?.serviceKey).toUpperCase() === serviceKey &&
      (source === cycleSourcePrefix ||
        source.startsWith(
          `subscription_cycle:${String(cycle._id)}:`
        ))
    );
  });

  const orderIds = paidCreditOrders.map((row) => String(row.order._id));

  const orderLots = lots.filter(
    (lot) =>
      clean(lot?.serviceKey).toUpperCase() === serviceKey &&
      orderIds.includes(idOf(lot?.orderId))
  );

  const cycleLotId = idOf(cycle.creditGrant?.lotId);

  const relevantLotIds = Array.from(
    new Set(
      [
        ...historicalCycleLots.map(idOf),
        ...orderLots.map(idOf),
        cycleLotId,
      ].filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  );

  const appointments = relevantLotIds.length
    ? await queryWithSession(
        Appointment.find({
          user: user._id,
          serviceKey,
          creditLotId: { $in: relevantLotIds },
        }).sort({ date: 1, time: 1, createdAt: 1 }),
        session
      )
    : [];

  const consumingAppointments = appointments.filter(consumesSession);
  const consumedSessions = consumingAppointments.length;

  const errors = [];

  if (subscription.status !== "active") {
    errors.push(`SUBSCRIPTION_NOT_ACTIVE:${subscription.status}`);
  }

  if (cycle.lifecycle?.planStatus !== "active") {
    errors.push(
      `CYCLE_LIFECYCLE_NOT_ACTIVE:${cycle.lifecycle?.planStatus || ""}`
    );
  }

  if (paidCreditOrders.length !== 1) {
    errors.push(
      `EXPECTED_ONE_PAID_CREDITS_ORDER:${paidCreditOrders.length}`
    );
  }

  const paidRow = paidCreditOrders[0] || null;
  const entitlementSessions = paidRow?.credits || 0;

  const matchingOrderLots = paidRow
    ? orderLots.filter(
        (lot) => idOf(lot.orderId) === String(paidRow.order._id)
      )
    : [];

  if (paidRow && matchingOrderLots.length !== 1) {
    errors.push(`EXPECTED_ONE_ORDER_LOT:${matchingOrderLots.length}`);
  }

  const orderLot = matchingOrderLots[0] || null;

  if (
    orderLot &&
    asInt(orderLot.amount) !== entitlementSessions
  ) {
    errors.push(
      `ORDER_LOT_AMOUNT_MISMATCH:${asInt(orderLot.amount)}!=${entitlementSessions}`
    );
  }

  if (historicalCycleLots.length < 1) {
    errors.push("HISTORICAL_CYCLE_LOT_NOT_FOUND");
  }

  const expectedRemaining = Math.max(
    0,
    entitlementSessions - consumedSessions
  );

  const orderRemaining = orderLot ? asInt(orderLot.remaining) : 0;

  const historicalCycleRemaining = historicalCycleLots.reduce(
    (sum, lot) => sum + asInt(lot.remaining),
    0
  );

  const currentRelevantRemaining =
    orderRemaining + historicalCycleRemaining;

  const cycleGrantPointsToOrderLot =
    !!orderLot && cycleLotId === idOf(orderLot);

  const cycleGrantPointsToHistoricalCycleLot =
    historicalCycleLots.some((lot) => idOf(lot) === cycleLotId);

  const alreadyCanonical =
    !!orderLot &&
    cycleGrantPointsToOrderLot &&
    historicalCycleRemaining === 0 &&
    currentRelevantRemaining === expectedRemaining &&
    asInt(cycle.creditGrant?.grantedSessions) === entitlementSessions;

  let classification = "STRUCTURE_REVIEW";

  if (alreadyCanonical) {
    classification = "ALREADY_CANONICAL";
  } else if (errors.length) {
    classification = "STRUCTURE_REVIEW";
  } else if (consumedSessions > entitlementSessions) {
    classification = "CONSUMPTION_EXCEEDS_PAID_SESSIONS_REVIEW";
  } else {
    classification = "SAFE_RECONCILIATION_CANDIDATE";
  }

  return {
    cycle,
    user,
    subscription,
    paidCreditOrders,
    paidRow,
    orderLots,
    orderLot,
    historicalCycleLots,
    relevantLotIds,
    appointments,
    consumingAppointments,
    consumedSessions,
    entitlementSessions,
    expectedRemaining,
    orderRemaining,
    historicalCycleRemaining,
    currentRelevantRemaining,
    cycleLotId,
    cycleGrantPointsToOrderLot,
    cycleGrantPointsToHistoricalCycleLot,
    alreadyCanonical,
    classification,
    errors,
  };
}

function printRow(row) {
  const email = clean(row.user?.email).toLowerCase() || "(sin email)";

  console.log(`\n${email}`);

  console.log(
    `  Subscription=${row.subscription?.status || "-"} | ` +
      `cycle=${row.cycle?.lifecycle?.planStatus || "-"} / ${
        row.cycle?.billing?.status || "-"
      }`
  );

  if (row.paidRow) {
    console.log(
      `  Order ${String(row.paidRow.order._id)}: ` +
        `${row.entitlementSessions} sesiones / $${money(
          row.paidRow.order.totalFinal ??
            row.paidRow.order.total ??
            row.paidRow.order.price
        )}`
    );
  }

  if (row.orderLot) {
    console.log(
      `  Order lot ${idOf(row.orderLot)}: ` +
        `amount=${asInt(row.orderLot.amount)} ` +
        `remaining=${asInt(row.orderLot.remaining)}`
    );
  }

  for (const lot of row.historicalCycleLots || []) {
    console.log(
      `  Cycle-source lot ${idOf(lot)}: ` +
        `amount=${asInt(lot.amount)} remaining=${asInt(lot.remaining)}`
    );
  }

  console.log(
    `  Consumos reales=${row.consumedSessions} | ` +
      `saldo correcto=${row.expectedRemaining} | ` +
      `saldo actual relevante=${row.currentRelevantRemaining}`
  );

  console.log(`  CLASIFICACIÓN=${row.classification}`);

  for (const error of row.errors || []) {
    console.log(`    ERROR ${error}`);
  }
}

function ensureBackupDir() {
  const dir = path.resolve(
    process.cwd(),
    "backups",
    "subscription-repairs"
  );

  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function serializable(doc) {
  return doc?.toObject
    ? doc.toObject({ depopulate: true })
    : doc;
}

async function writeBackup(rows, periodKey, serviceKey) {
  const dir = ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const file = path.join(
    dir,
    `before-reconcile-safe-duplicates-${periodKey}-${serviceKey}-${stamp}.json`
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    periodKey,
    serviceKey,
    rows: rows.map((row) => ({
      email: clean(row.user?.email).toLowerCase(),
      user: serializable(row.user),
      cycle: serializable(row.cycle),
      subscription: serializable(row.subscription),
      order: serializable(row.paidRow?.order),
      orderLotId: idOf(row.orderLot),
      historicalCycleLotIds: row.historicalCycleLots.map(idOf),
      appointments: row.appointments.map(serializable),
      entitlementSessions: row.entitlementSessions,
      consumedSessions: row.consumedSessions,
      expectedRemaining: row.expectedRemaining,
    })),
  };

  fs.writeFileSync(
    file,
    JSON.stringify(payload, null, 2)
  );

  return file;
}

async function applyRow({
  cycleId,
  periodKey,
  serviceKey,
}) {
  const session = await mongoose.startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      const row = await inspectCycle({
        cycleId,
        periodKey,
        serviceKey,
        session,
      });

      if (
        row.classification === "ALREADY_CANONICAL"
      ) {
        result = {
          ok: true,
          skipped: true,
          reason: "ALREADY_CANONICAL",
          email: clean(row.user?.email).toLowerCase(),
        };
        return;
      }

      if (
        row.classification !==
        "SAFE_RECONCILIATION_CANDIDATE"
      ) {
        const err = new Error(
          `NOT_SAFE_ANYMORE:${row.classification}`
        );
        err.details = row.errors;
        throw err;
      }

      const user = row.user;
      const cycle = row.cycle;
      const orderLot = row.orderLot;
      const oldLotIds = row.historicalCycleLots.map(idOf);

      const now = new Date();

      // 1) Todos los appointments que todavía apuntan al lote duplicado
      //    pasan al lote de la Order. No cambiamos status, refunds ni turnos.
      let migratedAppointments = 0;

      for (const ap of row.appointments) {
        const currentLotId = idOf(ap.creditLotId);

        if (
          oldLotIds.includes(currentLotId) &&
          currentLotId !== idOf(orderLot)
        ) {
          ap.creditLotId = orderLot._id;
          ap.creditExpiresAt = orderLot.expiresAt || null;
          await ap.save({ session });
          migratedAppointments += 1;
        }
      }

      // 2) El lote de la Order queda como entitlement canónico.
      orderLot.amount = row.entitlementSessions;
      orderLot.remaining = row.expectedRemaining;

      // 3) El/los lote(s) generados por el ciclo quedan históricos, sin saldo.
      for (const oldLot of row.historicalCycleLots) {
        if (idOf(oldLot) === idOf(orderLot)) continue;
        oldLot.remaining = 0;
      }

      // 4) El ciclo pasa a señalar al lote canónico de la Order.
      //    NO tocamos billing, total, amountReceived, lifecycle, plan ni precio.
      cycle.creditGrant.granted = true;
      cycle.creditGrant.grantedSessions =
        row.entitlementSessions;
      cycle.creditGrant.lotId = orderLot._id;
      cycle.creditGrant.expiresAt =
        orderLot.expiresAt || null;
      cycle.creditGrant.invalidatedAt = null;
      cycle.creditGrant.invalidationReason = "";

      await cycle.save({ session });

      // 5) Recalcula el total operativo de créditos del usuario.
      recalcUserCredits(user, now);

      user.history = Array.isArray(user.history)
        ? user.history
        : [];

      user.history.push({
        action:
          "subscription_duplicate_credit_lots_reconciled",
        title: "Créditos duplicados reconciliados",
        message:
          `Se unificó el crédito del ciclo ${periodKey} con la Order ${String(
            row.paidRow.order._id
          )}. Sesiones válidas: ${row.entitlementSessions}. ` +
          `Consumos: ${row.consumedSessions}. Saldo: ${row.expectedRemaining}.`,
        serviceKey,
        service: "Entrenamiento Personal",
        serviceName: "Entrenamiento Personal",
        qty: row.entitlementSessions,
        createdAt: now,
      });

      await user.save({ session });

      result = {
        ok: true,
        skipped: false,
        email: clean(user.email).toLowerCase(),
        cycleId: String(cycle._id),
        orderId: String(row.paidRow.order._id),
        canonicalLotId: idOf(orderLot),
        historicalLotsNeutralized:
          row.historicalCycleLots
            .filter((lot) => idOf(lot) !== idOf(orderLot))
            .map(idOf),
        migratedAppointments,
        sessionsPurchased: row.entitlementSessions,
        consumedSessions: row.consumedSessions,
        remaining: row.expectedRemaining,
        userCreditsAfter: Number(user.credits || 0),
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

async function main() {
  const { periodKey, serviceKey, only, apply } =
    parseArgs();

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const cycleQuery = {
      periodKey,
      serviceKey,
    };

    const cycles =
      await SubscriptionBillingCycle.find(cycleQuery)
        .select("_id")
        .sort({ createdAt: 1 })
        .lean();

    console.log("\n" + "=".repeat(126));
    console.log(
      `RECONCILIAR DUPLICADOS SEGUROS · ${periodKey} · ${serviceKey} · ${
        apply ? "APPLY" : "DRY RUN"
      }`
    );
    console.log("=".repeat(126));

    const rows = [];

    for (const cycle of cycles) {
      const row = await inspectCycle({
        cycleId: cycle._id,
        periodKey,
        serviceKey,
      });

      if (!row.user) continue;

      const email = clean(row.user.email).toLowerCase();

      if (only && email !== only) continue;

      // Para no ensuciar la salida, mostramos solo casos con Order CREDITS
      // paga del período o con estructura relevante de lotes.
      if (
        row.paidCreditOrders.length === 0 &&
        row.historicalCycleLots.length === 0
      ) {
        continue;
      }

      rows.push(row);
      printRow(row);
    }

    const ready = rows.filter(
      (row) =>
        row.classification ===
        "SAFE_RECONCILIATION_CANDIDATE"
    );

    const canonical = rows.filter(
      (row) =>
        row.classification === "ALREADY_CANONICAL"
    );

    const consumptionReview = rows.filter(
      (row) =>
        row.classification ===
        "CONSUMPTION_EXCEEDS_PAID_SESSIONS_REVIEW"
    );

    const structureReview = rows.filter(
      (row) =>
        row.classification === "STRUCTURE_REVIEW"
    );

    console.log("\n" + "-".repeat(126));
    console.log({
      periodKey,
      serviceKey,
      cyclesRead: cycles.length,
      rows: rows.length,
      ready: ready.length,
      alreadyCanonical: canonical.length,
      consumptionReview: consumptionReview.length,
      structureReview: structureReview.length,
      sessionsPurchasedReady: ready.reduce(
        (sum, row) => sum + row.entitlementSessions,
        0
      ),
      consumedReady: ready.reduce(
        (sum, row) => sum + row.consumedSessions,
        0
      ),
      expectedRemainingReady: ready.reduce(
        (sum, row) => sum + row.expectedRemaining,
        0
      ),
      inflatedRemainingToRemove: ready.reduce(
        (sum, row) =>
          sum +
          Math.max(
            0,
            row.currentRelevantRemaining -
              row.expectedRemaining
          ),
        0
      ),
      appointmentsToMigrate: ready.reduce(
        (sum, row) =>
          sum +
          row.appointments.filter((ap) =>
            row.historicalCycleLots
              .map(idOf)
              .includes(idOf(ap.creditLotId))
          ).length,
        0
      ),
    });

    if (!apply) {
      console.log(
        "\nDRY RUN: NO SE MODIFICÓ NINGÚN DATO."
      );

      if (ready.length) {
        console.log(
          `Para aplicar SOLO los SAFE: node scripts/reconcileSafeDuplicateCreditsV1.js --period=${periodKey} --service=${serviceKey} --apply`
        );
      }

      return;
    }

    if (!ready.length) {
      console.log("\nNo hay casos SAFE para aplicar.");
      return;
    }

    const backupPath = await writeBackup(
      ready,
      periodKey,
      serviceKey
    );

    console.log(`\nBackup: ${backupPath}`);

    const results = [];

    for (const row of ready) {
      try {
        const result = await applyRow({
          cycleId: row.cycle._id,
          periodKey,
          serviceKey,
        });

        results.push(result);

        console.log(
          `OK ${result.email}: sesiones=${result.sessionsPurchased} ` +
            `consumidas=${result.consumedSessions} ` +
            `saldo=${result.remaining} ` +
            `appointmentsMigrados=${result.migratedAppointments}`
        );
      } catch (error) {
        results.push({
          ok: false,
          email: clean(row.user?.email).toLowerCase(),
          error: error?.message || String(error),
          details: error?.details || [],
        });

        console.error(
          `ERROR ${clean(row.user?.email).toLowerCase()}: ${
            error?.message || error
          }`
        );
      }
    }

    const resultDir = ensureBackupDir();
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    const resultPath = path.join(
      resultDir,
      `reconcile-safe-duplicates-result-${periodKey}-${serviceKey}-${stamp}.json`
    );

    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          periodKey,
          serviceKey,
          backupPath,
          results,
        },
        null,
        2
      )
    );

    console.log("\n" + "=".repeat(126));
    console.log("RECONCILIACIÓN TERMINADA");
    console.log(
      `OK: ${results.filter((item) => item?.ok).length}`
    );
    console.log(
      `ERROR: ${results.filter((item) => !item?.ok).length}`
    );
    console.log(`Resultado: ${resultPath}`);
    console.log("=".repeat(126));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(
    "\nRECONCILE ERROR:",
    error?.stack || error?.message || error
  );

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
