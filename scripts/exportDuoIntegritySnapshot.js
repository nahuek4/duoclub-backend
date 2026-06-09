// backend/src/scripts/exportDuoIntegritySnapshot.js
// Script SOLO LECTURA: no modifica usuarios, turnos, turnos fijos, deudas ni créditos.
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import FixedSchedule from "../models/FixedSchedule.js";

const SERVICE_KEYS = ["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"];

function n(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function ymdhms(d = new Date()) {
  const pad = (x) => String(x).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

function lotIsActive(lot) {
  const rem = n(lot?.remaining);
  if (rem <= 0) return false;
  if (!lot?.expiresAt) return true;
  return new Date(lot.expiresAt).getTime() > Date.now();
}

function emptyByService() {
  return Object.fromEntries(SERVICE_KEYS.map((k) => [k, 0]));
}

function creditSummary(user) {
  const totalByService = emptyByService();
  const activeByService = emptyByService();
  const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];

  for (const lot of lots) {
    const sk = String(lot?.serviceKey || "").toUpperCase().trim();
    if (!SERVICE_KEYS.includes(sk)) continue;
    totalByService[sk] += n(lot?.remaining);
    if (lotIsActive(lot)) activeByService[sk] += n(lot?.remaining);
  }

  return { totalByService, activeByService, lotsCount: lots.length };
}

function debtSummary(user) {
  const raw = user?.fixedScheduleDebt || {};
  return {
    EP: n(raw.EP),
    RA: n(raw.RA),
    RF: n(raw.RF),
    KD: n(raw.KD),
    SYN: n(raw.SYN),
  };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Falta MONGO_URI en .env");

  await mongoose.connect(uri);

  const users = await User.find({}).select("name lastName email phone credits creditLots fixedScheduleDebt firstEvaluationCompleted role approvalStatus suspended").lean();

  const userIds = users.map((u) => u._id);

  const appointmentsByUser = await Appointment.aggregate([
    { $match: { user: { $in: userIds } } },
    {
      $group: {
        _id: { user: "$user", serviceKey: "$serviceKey", status: "$status", creditDebitStatus: "$creditDebitStatus" },
        count: { $sum: 1 },
      },
    },
  ]);

  const fixedSchedulesByUser = await FixedSchedule.aggregate([
    { $match: { user: { $in: userIds } } },
    {
      $group: {
        _id: { user: "$user", serviceKey: "$serviceKey", active: "$active" },
        count: { $sum: 1 },
      },
    },
  ]);

  const apMap = new Map();
  for (const row of appointmentsByUser) {
    const userId = String(row?._id?.user || "");
    if (!apMap.has(userId)) apMap.set(userId, []);
    apMap.get(userId).push({
      serviceKey: row._id.serviceKey || "",
      status: row._id.status || "",
      creditDebitStatus: row._id.creditDebitStatus || "",
      count: row.count,
    });
  }

  const fsMap = new Map();
  for (const row of fixedSchedulesByUser) {
    const userId = String(row?._id?.user || "");
    if (!fsMap.has(userId)) fsMap.set(userId, []);
    fsMap.get(userId).push({
      serviceKey: row._id.serviceKey || "",
      active: Boolean(row._id.active),
      count: row.count,
    });
  }

  const rows = users.map((u) => {
    const credits = creditSummary(u);
    return {
      userId: String(u._id),
      name: [u.name, u.lastName].filter(Boolean).join(" ").trim(),
      email: u.email || "",
      phone: u.phone || "",
      role: u.role || "",
      approvalStatus: u.approvalStatus || "",
      suspended: Boolean(u.suspended),
      creditsCache: n(u.credits),
      creditLotsCount: credits.lotsCount,
      activeCreditsByService: credits.activeByService,
      totalRemainingCreditsByService: credits.totalByService,
      fixedScheduleDebt: debtSummary(u),
      appointmentsSummary: apMap.get(String(u._id)) || [],
      fixedSchedulesSummary: fsMap.get(String(u._id)) || [],
    };
  });

  const totals = {
    users: rows.length,
    activeCreditsByService: emptyByService(),
    fixedScheduleDebt: { EP: 0, RA: 0, RF: 0, KD: 0, SYN: 0 },
  };

  for (const row of rows) {
    for (const sk of SERVICE_KEYS) totals.activeCreditsByService[sk] += n(row.activeCreditsByService[sk]);
    for (const sk of ["EP", "RA", "RF", "KD", "SYN"]) totals.fixedScheduleDebt[sk] += n(row.fixedScheduleDebt[sk]);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    note: "Snapshot previo/post cambio. Este script no ejecuta save(), update(), delete() ni bulkWrite().",
    totals,
    users: rows,
  };

  const outDir = path.resolve(process.cwd(), "backups", "integrity-snapshots");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `duo-integrity-snapshot-${ymdhms()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log("Snapshot generado:", outPath);
  console.log(JSON.stringify(totals, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("No se pudo generar el snapshot:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
