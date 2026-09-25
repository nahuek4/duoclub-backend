// scripts/auditOverconsumedPaidSessionsV1.js
//
// DUO CLUB — auditoría de los casos donde los consumos reales superan
// las sesiones pagas detectadas en septiembre.
//
// SOLO LECTURA.
//
// Busca:
// - Order CREDITS base;
// - Orders adicionales del mismo servicio:
//     SUBSCRIPTION_EXTRA
//     MANUAL_SERVICE
//     otras CREDITS pagas
//     SUBSCRIPTION_RENEWAL (se informa, NO suma sesiones);
// - todos los appointments que consumen de los lotes implicados;
// - si el exceso fue fijo o libre;
// - si hay órdenes extra que justifiquen el exceso.
//
// Uso:
//   node scripts/auditOverconsumedPaidSessionsV1.js --period=2026-09 --service=EP
//
// Opcional:
//   --only=email@dominio.com

import "dotenv/config";
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

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--period=")) {
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

  return { periodKey, serviceKey, only };
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

function sessionItems(order, serviceKey) {
  const sk = clean(serviceKey).toUpperCase();
  const allowed = new Set([
    "CREDITS",
    "MANUAL_SERVICE",
    "SUBSCRIPTION_EXTRA",
    "SUBSCRIPTION_RENEWAL",
  ]);

  return (Array.isArray(order?.items) ? order.items : [])
    .filter((item) => allowed.has(clean(item?.kind).toUpperCase()))
    .filter((item) => {
      const itemSk = clean(item?.serviceKey).toUpperCase();
      return !itemSk || itemSk === sk;
    })
    .map((item) => {
      const qty = Math.max(1, asInt(item?.qty) || 1);
      return {
        kind: clean(item?.kind).toUpperCase(),
        serviceKey: clean(item?.serviceKey).toUpperCase(),
        credits: asInt(item?.credits) * qty,
        qty,
        periodKey: clean(item?.periodKey),
        subscription: idOf(item?.subscription),
        subscriptionCycle: idOf(item?.subscriptionCycle),
        label: clean(item?.label),
        price: money(item?.price),
      };
    });
}

function isLifecycleCancellation(ap) {
  return (
    clean(ap?.status).toLowerCase() === "cancelled" &&
    /falta de pago|plan mensual/i.test(clean(ap?.cancelReason))
  );
}

function consumesSession(ap) {
  const status = clean(ap?.status).toLowerCase();

  if (status === "reserved" || status === "completed") return true;

  if (
    status === "cancelled" &&
    ap?.refundApplied !== true &&
    !isLifecycleCancellation(ap)
  ) {
    return true;
  }

  return false;
}

function appointmentSummary(ap, lotKind) {
  return {
    id: String(ap._id),
    date: clean(ap.date).slice(0, 10),
    time: clean(ap.time).slice(0, 5),
    status: clean(ap.status),
    fixed: !!ap.fixedScheduleId,
    fixedScheduleId: idOf(ap.fixedScheduleId),
    assignedManually: ap.assignedManually === true,
    creditDebitStatus: clean(ap.creditDebitStatus),
    refundApplied: ap.refundApplied === true,
    cancelReason: clean(ap.cancelReason),
    lotKind,
    lotId: idOf(ap.creditLotId),
    createdAt: ap.createdAt || null,
  };
}

async function inspectCycle(cycle, serviceKey, bounds) {
  const [user, subscription] = await Promise.all([
    User.findById(cycle.user),
    ServiceSubscription.findById(cycle.subscription).lean(),
  ]);

  if (!user || !subscription) return null;

  if (
    subscription.status !== "active" ||
    cycle.lifecycle?.planStatus !== "active"
  ) {
    return null;
  }

  const orders = await Order.find({
    user: user._id,
    status: { $in: ["paid", "approved"] },
    $or: [
      { paidAt: { $gte: bounds.startDate, $lte: bounds.endDate } },
      {
        paidAt: null,
        createdAt: { $gte: bounds.startDate, $lte: bounds.endDate },
      },
    ],
  })
    .sort({ paidAt: 1, createdAt: 1 })
    .lean();

  const sessionOrders = orders
    .map((order) => {
      const items = sessionItems(order, serviceKey);
      return {
        order,
        items,
        credits: items.reduce((sum, item) => sum + item.credits, 0),
        baseCredits: items
          .filter((item) => item.kind === "CREDITS")
          .reduce((sum, item) => sum + item.credits, 0),
        explicitExtraCredits: items
          .filter((item) =>
            ["SUBSCRIPTION_EXTRA", "MANUAL_SERVICE"].includes(item.kind)
          )
          .reduce((sum, item) => sum + item.credits, 0),
        renewalCredits: items
          .filter((item) => item.kind === "SUBSCRIPTION_RENEWAL")
          .reduce((sum, item) => sum + item.credits, 0),
      };
    })
    .filter((row) => row.credits > 0);

  const creditOrders = sessionOrders.filter((row) => row.baseCredits > 0);

  if (creditOrders.length !== 1) return null;

  const baseRow = creditOrders[0];
  const baseEntitlement = baseRow.baseCredits;

  const allOrderIds = sessionOrders.map((row) => String(row.order._id));

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  const cycleSourcePrefix = `subscription_cycle:${String(cycle._id)}:${cycle.periodKey}`;

  const cycleLots = lots.filter((lot) => {
    const source = clean(lot?.source);
    return (
      clean(lot?.serviceKey).toUpperCase() === serviceKey &&
      (source === cycleSourcePrefix ||
        source.startsWith(`subscription_cycle:${String(cycle._id)}:`))
    );
  });

  const orderLots = lots.filter(
    (lot) =>
      clean(lot?.serviceKey).toUpperCase() === serviceKey &&
      allOrderIds.includes(idOf(lot?.orderId))
  );

  const relevantLotIds = Array.from(
    new Set(
      [...cycleLots.map(idOf), ...orderLots.map(idOf)].filter((id) =>
        mongoose.Types.ObjectId.isValid(id)
      )
    )
  );

  const appointments = relevantLotIds.length
    ? await Appointment.find({
        user: user._id,
        serviceKey,
        creditLotId: { $in: relevantLotIds },
      })
        .sort({ date: 1, time: 1, createdAt: 1 })
        .lean()
    : [];

  const cycleLotIds = new Set(cycleLots.map(idOf));
  const orderLotById = new Map(orderLots.map((lot) => [idOf(lot), lot]));

  const consuming = appointments.filter(consumesSession);

  const consumingDetailed = consuming.map((ap) => {
    const lotId = idOf(ap.creditLotId);
    const lot = orderLotById.get(lotId);

    let lotKind = "OTHER";
    if (cycleLotIds.has(lotId)) {
      lotKind = "CYCLE";
    } else if (lot) {
      const oid = idOf(lot.orderId);
      const orderRow = sessionOrders.find(
        (row) => String(row.order._id) === oid
      );

      if (orderRow) {
        const kinds = [...new Set(orderRow.items.map((item) => item.kind))];
        lotKind = `ORDER:${kinds.join("+")}`;
      } else {
        lotKind = "ORDER";
      }
    }

    return appointmentSummary(ap, lotKind);
  });

  const consumed = consumingDetailed.length;
  if (consumed <= baseEntitlement) return null;

  const explicitExtraCredits = sessionOrders.reduce(
    (sum, row) => sum + row.explicitExtraCredits,
    0
  );

  const otherCreditsOrders = sessionOrders.filter(
    (row) =>
      row.baseCredits > 0 &&
      String(row.order._id) !== String(baseRow.order._id)
  );

  const overage = consumed - baseEntitlement;
  const totalWithExplicitExtras = baseEntitlement + explicitExtraCredits;

  const overageAppointments = consumingDetailed.slice(baseEntitlement);

  const duplicateSlotGroups = Object.values(
    consumingDetailed.reduce((acc, ap) => {
      const key = `${ap.date}|${ap.time}`;
      acc[key] = acc[key] || [];
      acc[key].push(ap);
      return acc;
    }, {})
  ).filter((group) => group.length > 1);

  let classification = "OVERAGE_WITHOUT_EXTRA_PAYMENT";

  if (otherCreditsOrders.length > 0) {
    classification = "MULTIPLE_CREDITS_ORDERS_REVIEW";
  } else if (
    explicitExtraCredits > 0 &&
    totalWithExplicitExtras >= consumed
  ) {
    classification = "EXPLICIT_EXTRA_ORDER_COVERS_OVERAGE";
  } else if (
    explicitExtraCredits > 0 &&
    totalWithExplicitExtras < consumed
  ) {
    classification = "EXTRA_ORDER_PARTIALLY_COVERS_OVERAGE";
  } else if (duplicateSlotGroups.length > 0) {
    classification = "DUPLICATE_APPOINTMENT_SLOT_REVIEW";
  }

  return {
    email: clean(user.email).toLowerCase(),
    userId: String(user._id),
    subscription,
    cycle,
    baseRow,
    sessionOrders,
    cycleLots,
    orderLots,
    consumed,
    baseEntitlement,
    overage,
    explicitExtraCredits,
    totalWithExplicitExtras,
    consumingDetailed,
    overageAppointments,
    duplicateSlotGroups,
    classification,
  };
}

function printOrder(row) {
  const kinds = row.items
    .map((item) => `${item.kind}:${item.credits}`)
    .join(",");

  console.log(
    `    Order ${String(row.order._id)} $${money(
      row.order.totalFinal ?? row.order.total ?? row.order.price
    )} admin=${row.order.createdByAdmin ? "SI" : "NO"} ` +
      `items=[${kinds}] paidAt=${row.order.paidAt || row.order.createdAt || "-"}`
  );
}

async function main() {
  const { periodKey, serviceKey, only } = parseArgs();
  const bounds = periodBounds(periodKey);

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const cycles = await SubscriptionBillingCycle.find({
      periodKey,
      serviceKey,
    })
      .sort({ createdAt: 1 })
      .lean();

    console.log("\n" + "=".repeat(132));
    console.log(
      `AUDITORÍA SOBRERCONSUMO · ${periodKey} · ${serviceKey} · SOLO LECTURA`
    );
    console.log("=".repeat(132));

    const rows = [];

    for (const cycle of cycles) {
      const row = await inspectCycle(cycle, serviceKey, bounds);
      if (!row) continue;
      if (only && row.email !== only) continue;

      rows.push(row);

      console.log(`\n${row.email}`);
      console.log(
        `  Plan=${asInt(row.subscription.monthlySessions)} / $${money(
          row.subscription.price
        )} | cycle billing=${row.cycle.billing?.status || "-"}`
      );

      console.log(
        `  Base pagada=${row.baseEntitlement} | consumos=${row.consumed} | ` +
          `EXCESO=${row.overage} | extras explícitos=${row.explicitExtraCredits} | ` +
          `total con extras=${row.totalWithExplicitExtras}`
      );

      console.log("  Orders del período:");
      for (const orderRow of row.sessionOrders) {
        printOrder(orderRow);
      }

      console.log("  Consumos:");
      for (const ap of row.consumingDetailed) {
        console.log(
          `    ${ap.date} ${ap.time} ${ap.status} ` +
            `${ap.fixed ? "FIJO" : "LIBRE"} ` +
            `lot=${ap.lotKind} debit=${ap.creditDebitStatus || "-"} ` +
            `manual=${ap.assignedManually ? "SI" : "NO"}`
        );
      }

      console.log("  EXCESO PROPUESTO PARA REVISAR:");
      for (const ap of row.overageAppointments) {
        console.log(
          `    ${ap.date} ${ap.time} ${ap.status} ` +
            `${ap.fixed ? "FIJO" : "LIBRE"} lot=${ap.lotKind} id=${ap.id}`
        );
      }

      if (row.duplicateSlotGroups.length) {
        console.log(
          `  DUPLICADOS MISMO DÍA/HORA: ${row.duplicateSlotGroups.length}`
        );
      }

      console.log(`  CLASIFICACIÓN: ${row.classification}`);
    }

    const summary = {
      periodKey,
      serviceKey,
      cases: rows.length,
      totalOverage: rows.reduce((sum, row) => sum + row.overage, 0),
      classifications: rows.reduce((acc, row) => {
        acc[row.classification] = Number(acc[row.classification] || 0) + 1;
        return acc;
      }, {}),
      overageFixedAppointments: rows.reduce(
        (sum, row) =>
          sum + row.overageAppointments.filter((ap) => ap.fixed).length,
        0
      ),
      overageFreeAppointments: rows.reduce(
        (sum, row) =>
          sum + row.overageAppointments.filter((ap) => !ap.fixed).length,
        0
      ),
      explicitExtraCredits: rows.reduce(
        (sum, row) => sum + row.explicitExtraCredits,
        0
      ),
      duplicateSlotGroups: rows.reduce(
        (sum, row) => sum + row.duplicateSlotGroups.length,
        0
      ),
    };

    console.log("\n" + "-".repeat(132));
    console.log(summary);
    console.log("\nNO SE MODIFICÓ NINGÚN DATO.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(
    "\nAUDIT ERROR:",
    error?.stack || error?.message || error
  );

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
