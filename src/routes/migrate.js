#!/usr/bin/env node
/**
 * Reset rápido de estado DUO:
 * - borra appointments
 * - borra waitlistentries
 * - borra orders
 * - deja creditLots = [] y credits = 0 en users
 *
 * Opcional:
 * - RESET_FIXED_SCHEDULES=true   -> borra fixedschedules
 * - RESET_MEMBERSHIP=true        -> resetea membresía a basic
 * - CLEAR_HISTORY=true           -> limpia history del usuario
 *
 * Seguridad:
 * - exige CONFIRM_RESET=RESET_DUO_STATE
 *
 * Uso:
 *   CONFIRM_RESET=RESET_DUO_STATE MONGO_URI="TU_URI" node scripts/reset_duo_state_v1.js
 *
 * Ejemplo completo:
 *   CONFIRM_RESET=RESET_DUO_STATE RESET_FIXED_SCHEDULES=true RESET_MEMBERSHIP=true MONGO_URI="TU_URI" node scripts/reset_duo_state_v1.js
 */

import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const CONFIRM_RESET = String(process.env.CONFIRM_RESET || "").trim();

const RESET_FIXED_SCHEDULES =
  String(process.env.RESET_FIXED_SCHEDULES || "false").toLowerCase() === "true";

const RESET_MEMBERSHIP =
  String(process.env.RESET_MEMBERSHIP || "false").toLowerCase() === "true";

const CLEAR_HISTORY =
  String(process.env.CLEAR_HISTORY || "false").toLowerCase() === "true";

if (!MONGO_URI) {
  console.error("Falta MONGO_URI / MONGODB_URI");
  process.exit(1);
}

if (CONFIRM_RESET !== "RESET_DUO_STATE") {
  console.error(
    'Abortado. Para ejecutar este reset tenés que pasar CONFIRM_RESET=RESET_DUO_STATE'
  );
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const report = {
    deleted: {
      appointments: 0,
      waitlistentries: 0,
      orders: 0,
      fixedschedules: 0,
    },
    updated: {
      usersCreditsReset: 0,
      usersMembershipReset: 0,
      usersHistoryCleared: 0,
    },
  };

  try {
    const appointmentsRes = await db.collection("appointments").deleteMany({});
    report.deleted.appointments = Number(appointmentsRes.deletedCount || 0);

    const waitlistRes = await db.collection("waitlistentries").deleteMany({});
    report.deleted.waitlistentries = Number(waitlistRes.deletedCount || 0);

    const ordersRes = await db.collection("orders").deleteMany({});
    report.deleted.orders = Number(ordersRes.deletedCount || 0);

    if (RESET_FIXED_SCHEDULES) {
      const fixedRes = await db.collection("fixedschedules").deleteMany({});
      report.deleted.fixedschedules = Number(fixedRes.deletedCount || 0);
    }

    const usersSet = {
      creditLots: [],
      credits: 0,
    };

    if (RESET_MEMBERSHIP) {
      usersSet["membership.tier"] = "basic";
      usersSet["membership.activeUntil"] = null;
      usersSet["membership.creditsExpireDays"] = 30;
      usersSet["membership.cancelHours"] = 24;
      usersSet["membership.cancelsLeft"] = 1;
    }

    const usersUpdate = { $set: usersSet };

    if (CLEAR_HISTORY) {
      usersUpdate.$set.history = [];
    }

    const usersRes = await db.collection("users").updateMany({}, usersUpdate);
    report.updated.usersCreditsReset = Number(usersRes.modifiedCount || 0);

    if (RESET_MEMBERSHIP) {
      report.updated.usersMembershipReset = Number(usersRes.modifiedCount || 0);
    }

    if (CLEAR_HISTORY) {
      report.updated.usersHistoryCleared = Number(usersRes.modifiedCount || 0);
    }

    console.log("Reset terminado.");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error en reset:", err);
  process.exit(1);
});
