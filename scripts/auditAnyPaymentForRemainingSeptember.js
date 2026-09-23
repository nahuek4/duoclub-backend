// scripts/auditAnyPaymentForRemainingSeptember.js
// SOLO LECTURA.
// Revisa los usuarios que quedaron en REVIEW_PAYMENT_MATCH y busca cualquier
// pago positivo del mismo servicio en septiembre, aunque no coincida con la
// cantidad de sesiones del plan.
//
// Uso:
//   node scripts/auditAnyPaymentForRemainingSeptember.js --period=2026-09

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import Order from "../src/models/Order.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

function clean(v) {
  return String(v ?? "").trim();
}

function money(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? clean(hit.slice(prefix.length)) : fallback;
}

function latestPreview(periodKey) {
  const dir = path.resolve(
    process.cwd(),
    "backups",
    "subscription-audits"
  );

  const prefix = `repair-preview-v5-${periodKey}-`;

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => {
      const full = path.join(dir, name);
      return {
        name,
        full,
        mtime: fs.statSync(full).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) {
    throw new Error(`No encontré preview V5 para ${periodKey}`);
  }

  return files[0].full;
}

function monthBoundsArgentina(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);

  const start = new Date(
    Date.UTC(year, month - 1, 1, 3, 0, 0, 0)
  );

  const next = new Date(
    Date.UTC(year, month, 1, 3, 0, 0, 0)
  );

  return {
    start,
    end: new Date(next.getTime() - 1),
  };
}

function orderAmount(order) {
  return money(
    order?.totalFinal ??
      order?.total ??
      order?.price ??
      order?.basePrice
  );
}

function sameServiceEvidence(order, serviceKey) {
  const key = clean(serviceKey).toUpperCase();

  const items = Array.isArray(order?.items) ? order.items : [];

  const matchingItems = items
    .filter(
      (item) =>
        clean(item?.serviceKey).toUpperCase() === key
    )
    .map((item) => ({
      kind: clean(item?.kind).toUpperCase(),
      serviceKey: clean(item?.serviceKey).toUpperCase(),
      credits: Number(item?.credits || 0),
      price: money(item?.price),
      basePrice: money(item?.basePrice),
      subscription: clean(item?.subscription),
      subscriptionCycle: clean(item?.subscriptionCycle),
      periodKey: clean(item?.periodKey),
    }));

  const legacyMatch =
    clean(order?.serviceKey).toUpperCase() === key;

  return {
    matchingItems,
    legacyMatch,
    matches:
      matchingItems.length > 0 ||
      legacyMatch,
  };
}

async function main() {
  const periodKey = parseArg("period", "2026-09");

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  const reportPath = latestPreview(periodKey);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  const rows = (Array.isArray(report?.rows) ? report.rows : []).filter(
    (row) =>
      clean(row?.decision) === "REVIEW_PAYMENT_MATCH"
  );

  const { start, end } = monthBoundsArgentina(periodKey);

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const findings = [];

    for (const row of rows) {
      const userId = clean(row?.user?.id);
      const email = clean(row?.user?.email);
      const serviceKey = clean(row?.serviceKey).toUpperCase();
      const cycleId = clean(row?.cycle?.id);

      const [orders, cycle] = await Promise.all([
        Order.find({
          user: userId,
          status: { $in: ["paid", "approved"] },
          $or: [
            {
              paidAt: {
                $gte: start,
                $lte: end,
              },
            },
            {
              paidAt: null,
              createdAt: {
                $gte: start,
                $lte: end,
              },
            },
          ],
        })
          .sort({ paidAt: 1, createdAt: 1 })
          .lean(),

        cycleId
          ? SubscriptionBillingCycle.findById(cycleId).lean()
          : null,
      ]);

      const sameServiceOrders = orders
        .map((order) => {
          const evidence = sameServiceEvidence(order, serviceKey);
          if (!evidence.matches) return null;

          return {
            orderId: String(order._id),
            paidAt: order.paidAt || order.createdAt,
            payMethod: clean(order.payMethod).toUpperCase(),
            amount: orderAmount(order),
            status: clean(order.status),
            matchingItems: evidence.matchingItems,
            legacyMatch: evidence.legacyMatch,
          };
        })
        .filter(Boolean)
        .filter((order) => order.amount > 0);

      const ledgerReceived = money(
        cycle?.billing?.amountReceived
      );

      const ledgerPayments = Array.isArray(
        cycle?.billing?.payments
      )
        ? cycle.billing.payments
            .map((payment) => ({
              orderId: clean(payment?.order),
              amount: money(payment?.amount),
              appliedAmount: money(payment?.appliedAmount),
              paidAt: payment?.paidAt || null,
              paymentProvider: clean(
                payment?.paymentProvider
              ),
            }))
            .filter((payment) => payment.amount > 0)
        : [];

      const anyMoney =
        ledgerReceived > 0 ||
        ledgerPayments.length > 0 ||
        sameServiceOrders.length > 0;

      findings.push({
        email,
        serviceKey,
        cycleId,
        anyMoney,
        ledgerReceived,
        ledgerPayments,
        sameServiceOrders,
      });
    }

    const withMoney = findings.filter((item) => item.anyMoney);
    const withoutMoney = findings.filter((item) => !item.anyMoney);

    console.log("\n" + "=".repeat(110));
    console.log(`AUDITORÍA AMPLIA DE PAGOS ${periodKey} · SOLO LECTURA`);
    console.log(`Preview: ${reportPath}`);
    console.log("=".repeat(110));

    for (const item of withMoney) {
      console.log(`\n${item.email} | ${item.serviceKey}`);
      console.log(`  >>> HAY EVIDENCIA DE DINERO CARGADO`);

      if (item.ledgerReceived > 0) {
        console.log(
          `  Ledger del ciclo: $${item.ledgerReceived}`
        );
      }

      for (const payment of item.ledgerPayments) {
        console.log(
          `  Ledger payment: $${payment.amount} | applied=$${payment.appliedAmount} | order=${payment.orderId || "-"}`
        );
      }

      for (const order of item.sameServiceOrders) {
        console.log(
          `  Order ${order.orderId} | $${order.amount} | ${order.payMethod} | ${order.paidAt}`
        );

        for (const detail of order.matchingItems) {
          console.log(
            `    item ${detail.kind} | credits=${detail.credits} | price=$${detail.price} | period=${detail.periodKey || "-"}`
          );
        }
      }
    }

    console.log("\n" + "-".repeat(110));
    console.log({
      reviewPaymentMatch: findings.length,
      conAlgunaEvidenciaDePago: withMoney.length,
      sinNingunaEvidenciaDePago: withoutMoney.length,
    });

    if (withoutMoney.length) {
      console.log("\nSIN NINGUNA EVIDENCIA DE PAGO:");
      for (const item of withoutMoney) {
        console.log(`  ${item.email} | ${item.serviceKey}`);
      }
    }

    console.log("\nNO SE MODIFICÓ NINGÚN DATO.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error("\nAUDIT ERROR:", error?.stack || error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
