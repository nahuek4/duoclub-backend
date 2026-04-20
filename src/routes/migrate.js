#!/usr/bin/env node
/**
 * Migra serviceKey/service/serviceName a claves canónicas:
 * PE, EP, RA, RF, NUT
 *
 * Uso:
 *   MONGO_URI="mongodb://..." node migrate_service_keys_v1.js
 */

import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb+srv://duoAdmin:uF45i2ZwwAHl0ULu@duo.7wc6neh.mongodb.net/duoagenda?retryWrites=true&w=majority&appName=Duo";

if (!MONGO_URI) {
  console.error("Falta MONGO_URI / MONGODB_URI");
  process.exit(1);
}

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  NUT: "Nutrición",
};

const VALID_KEYS = new Set(Object.keys(SERVICE_KEY_TO_NAME));

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKeyInput(...values) {
  for (const value of values) {
    const raw = String(value || "").toUpperCase().trim();
    if (!raw) continue;
    if (raw === "AR") return "RA";
    if (VALID_KEYS.has(raw)) return raw;

    const s = stripAccents(value).toLowerCase().trim();
    if (s.includes("primera") && s.includes("evaluacion")) return "PE";
    if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
    if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
    if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
    if (s.includes("nutric")) return "NUT";
  }
  return "";
}

function canonicalName(serviceKey, fallback = "") {
  return SERVICE_KEY_TO_NAME[serviceKey] || String(fallback || "").trim() || "";
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

async function migrateUsers(db, report) {
  const col = db.collection("users");
  const docs = await col.find({}).toArray();

  for (const doc of docs) {
    let changed = false;
    const next = clone(doc);

    if (Array.isArray(next.creditLots)) {
      next.creditLots = next.creditLots.map((lot) => {
        const normalized = normalizeServiceKeyInput(
          lot?.serviceKey,
          lot?.serviceName,
          lot?.service
        );

        if (!normalized) {
          report.unresolved.push({
            collection: "users.creditLots",
            id: String(doc._id),
            lotId: String(lot?._id || ""),
            raw: {
              serviceKey: lot?.serviceKey ?? null,
              serviceName: lot?.serviceName ?? null,
              service: lot?.service ?? null,
            },
          });
          return lot;
        }

        const out = { ...lot, serviceKey: normalized };
        if ("serviceName" in lot || lot?.serviceName) {
          out.serviceName = canonicalName(normalized, lot?.serviceName || lot?.service);
        }
        if ("service" in lot || lot?.service) {
          out.service = canonicalName(normalized, lot?.service || lot?.serviceName);
        }

        if (
          out.serviceKey !== lot?.serviceKey ||
          out.serviceName !== lot?.serviceName ||
          out.service !== lot?.service
        ) {
          changed = true
        }
        return out;
      });
    }

    if (Array.isArray(next.history)) {
      next.history = next.history.map((item) => {
        const normalized = normalizeServiceKeyInput(
          item?.serviceKey,
          item?.serviceName,
          item?.service
        );
        if (!normalized) return item;

        const out = { ...item, serviceKey: normalized };
        if ("serviceName" in item || item?.serviceName) {
          out.serviceName = canonicalName(normalized, item?.serviceName || item?.service);
        }
        if ("service" in item || item?.service) {
          out.service = canonicalName(normalized, item?.service || item?.serviceName);
        }

        if (
          out.serviceKey !== item?.serviceKey ||
          out.serviceName !== item?.serviceName ||
          out.service !== item?.service
        ) {
          changed = true;
        }
        return out;
      });
    }

    if (changed) {
      await col.updateOne(
        { _id: doc._id },
        { $set: { creditLots: next.creditLots || [], history: next.history || [] } }
      );
      report.updated.users += 1;
    }
  }
}

async function migrateAppointments(db, report) {
  const col = db.collection("appointments");
  const docs = await col.find({}).toArray();

  for (const doc of docs) {
    const normalized = normalizeServiceKeyInput(doc?.serviceKey, doc?.service, doc?.serviceName);
    if (!normalized) {
      report.unresolved.push({
        collection: "appointments",
        id: String(doc._id),
        raw: { serviceKey: doc?.serviceKey ?? null, service: doc?.service ?? null },
      });
      continue;
    }

    const nextService = canonicalName(normalized, doc?.service);
    if (doc.serviceKey !== normalized || doc.service !== nextService) {
      await col.updateOne(
        { _id: doc._id },
        { $set: { serviceKey: normalized, service: nextService } }
      );
      report.updated.appointments += 1;
    }
  }
}

async function migrateWaitlist(db, report) {
  const col = db.collection("waitlistentries");
  const docs = await col.find({}).toArray();

  for (const doc of docs) {
    const normalized = normalizeServiceKeyInput(doc?.serviceKey, doc?.service, doc?.serviceName);
    if (!normalized) {
      report.unresolved.push({
        collection: "waitlistentries",
        id: String(doc._id),
        raw: { serviceKey: doc?.serviceKey ?? null, service: doc?.service ?? null },
      });
      continue;
    }

    const nextService = canonicalName(normalized, doc?.service);
    if (doc.serviceKey !== normalized || doc.service !== nextService) {
      await col.updateOne(
        { _id: doc._id },
        { $set: { serviceKey: normalized, service: nextService } }
      );
      report.updated.waitlistentries += 1;
    }
  }
}

async function migrateFixedSchedules(db, report) {
  const col = db.collection("fixedschedules");
  const docs = await col.find({}).toArray();

  for (const doc of docs) {
    const normalized = normalizeServiceKeyInput(doc?.serviceKey, doc?.service, doc?.serviceName);
    if (!normalized) {
      report.unresolved.push({
        collection: "fixedschedules",
        id: String(doc._id),
        raw: { serviceKey: doc?.serviceKey ?? null, service: doc?.service ?? null },
      });
      continue;
    }

    const nextService = canonicalName(normalized, doc?.service);
    if (doc.serviceKey !== normalized || doc.service !== nextService) {
      await col.updateOne(
        { _id: doc._id },
        { $set: { serviceKey: normalized, service: nextService } }
      );
      report.updated.fixedschedules += 1;
    }
  }
}

async function migrateOrders(db, report) {
  const col = db.collection("orders");
  const docs = await col.find({}).toArray();

  for (const doc of docs) {
    let changed = false;
    const set = {};

    const normalizedLegacy = normalizeServiceKeyInput(doc?.serviceKey, doc?.service, doc?.label);
    if (normalizedLegacy && doc?.serviceKey !== normalizedLegacy) {
      set.serviceKey = normalizedLegacy;
      changed = true;
    }

    if (Array.isArray(doc.items)) {
      const nextItems = doc.items.map((item) => {
        if (String(item?.kind || "").toUpperCase().trim() !== "CREDITS") return item;
        const normalized = normalizeServiceKeyInput(item?.serviceKey, item?.label, item?.serviceName);
        if (!normalized) {
          report.unresolved.push({
            collection: "orders.items",
            id: String(doc._id),
            raw: { kind: item?.kind, serviceKey: item?.serviceKey ?? null, label: item?.label ?? null },
          });
          return item;
        }
        const out = { ...item, serviceKey: normalized };
        if (!out.label) out.label = canonicalName(normalized);
        if (out.serviceKey !== item?.serviceKey || out.label !== item?.label) changed = true;
        return out;
      });
      if (changed) set.items = nextItems;
    }

    if (changed) {
      await col.updateOne({ _id: doc._id }, { $set: set });
      report.updated.orders += 1;
    }
  }
}

async function migratePricingPlans(db, report) {
  const col = db.collection("pricingplans");
  const docs = await col.find({}).toArray();

  for (const doc of docs) {
    const normalized = normalizeServiceKeyInput(doc?.serviceKey, doc?.label);
    if (!normalized) {
      report.unresolved.push({
        collection: "pricingplans",
        id: String(doc._id),
        raw: { serviceKey: doc?.serviceKey ?? null, label: doc?.label ?? null },
      });
      continue;
    }

    if (doc.serviceKey !== normalized) {
      await col.updateOne({ _id: doc._id }, { $set: { serviceKey: normalized } });
      report.updated.pricingplans += 1;
    }
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const report = {
    updated: {
      users: 0,
      appointments: 0,
      waitlistentries: 0,
      fixedschedules: 0,
      orders: 0,
      pricingplans: 0,
    },
    unresolved: [],
  };

  try {
    await migrateUsers(db, report);
    await migrateAppointments(db, report);
    await migrateWaitlist(db, report);
    await migrateFixedSchedules(db, report);
    await migrateOrders(db, report);
    await migratePricingPlans(db, report);

    console.log("Migración terminada.");
    console.log(JSON.stringify(report, null, 2));

    if (report.unresolved.length > 0) {
      console.log("\nATENCIÓN: hay registros sin serviceKey resoluble automáticamente.");
      console.log("Revisalos antes de volver a guardar esos documentos.");
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error en migración:", err);
  process.exit(1);
});
