import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const SERVICES = ["EP", "RA", "RF", "KD", "SYN"];
const PAID_STATUSES = new Set(["paid", "approved"]);

const EXCLUDED_USER_IDS = new Set([
  "692c8747ac97e1bf8ba86839", // Admin DUO / usuario operativo de prueba
]);

const EXCLUDED_EMAILS = new Set([
  "admin@duoclub.ar",
]);

const EXCLUDED_ROLES = new Set([
  "admin",
  "staff",
  "profesor",
  "professor",
  "coach",
]);

function norm(v = "") {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function serviceKey(v = "") {
  const up = String(v || "").toUpperCase().trim();
  if (SERVICES.includes(up)) return up;
  const s = norm(v);
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia")) return "SYN";
  return "";
}

function emptyByService() {
  return Object.fromEntries(SERVICES.map((s) => [s, 0]));
}

function add(map, sk, qty) {
  if (!SERVICES.includes(sk)) return;
  const n = Number(qty || 0);
  if (!Number.isFinite(n)) return;
  map[sk] = Number(map[sk] || 0) + n;
}

function sumMap(map = {}) {
  return SERVICES.reduce((a, sk) => a + Math.max(0, Number(map?.[sk] || 0)), 0);
}

function positiveDiff(left = {}, right = {}) {
  const out = emptyByService();
  for (const sk of SERVICES) {
    out[sk] = Math.max(0, Number(left?.[sk] || 0) - Number(right?.[sk] || 0));
  }
  return out;
}

function qtyOf(item) {
  const n = Number(item?.qty ?? item?.amount ?? item?.value ?? 0);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function dateValue(v) {
  if (!v) return 0;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function fullName(u = {}) {
  return (
    String(u.fullName || "").trim() ||
    `${String(u.name || "").trim()} ${String(u.lastName || "").trim()}`.trim() ||
    "Usuario"
  );
}

function isExcludedUser(user = {}) {
  const id = String(user?._id || user?.id || "").trim();
  const email = String(user?.email || "").toLowerCase().trim();
  const role = String(user?.role || "").toLowerCase().trim();

  return EXCLUDED_USER_IDS.has(id) || EXCLUDED_EMAILS.has(email) || EXCLUDED_ROLES.has(role);
}

function currentDebtByService(user = {}) {
  const out = emptyByService();
  const raw = user.fixedScheduleDebt || {};
  for (const sk of SERVICES) out[sk] = Math.max(0, Number(raw[sk] || 0));
  return out;
}

function extractOrderCreditEvents(order = {}) {
  const out = [];
  const status = String(order.status || "").toLowerCase().trim();
  if (!PAID_STATUSES.has(status)) return out;

  const createdAt = order.paidAt || order.approvedAt || order.createdAt || order.updatedAt || null;
  const orderId = String(order._id || "");

  if (Array.isArray(order.items)) {
    for (const it of order.items) {
      const kind = String(it?.kind || "").toUpperCase().trim();
      const sk = serviceKey(it?.serviceKey || it?.service || it?.serviceName || it?.label || "");
      const credits = Number(it?.credits || it?.sessions || it?.quantity || 0);
      if ((kind === "CREDITS" || credits > 0) && sk && credits > 0) {
        out.push({ type: "order_paid_credits", serviceKey: sk, qty: credits, createdAt, orderId, status });
      }
    }
  }

  const legacySk = serviceKey(order.serviceKey || order.service || order.serviceName || "");
  const legacyCredits = Number(order.credits || 0);
  if (legacySk && legacyCredits > 0) {
    out.push({ type: "order_paid_credits", serviceKey: legacySk, qty: legacyCredits, createdAt, orderId, status });
  }

  return out;
}

function readByService(obj = {}) {
  const candidates = [
    obj?.byService,
    obj?.creditsByService,
    obj?.creditsByServiceKey,
    obj?.serviceCredits,
    obj,
  ].filter(Boolean);

  const out = emptyByService();
  for (const c of candidates) {
    let found = false;
    for (const sk of SERVICES) {
      if (c?.[sk] !== undefined) {
        out[sk] = Number(c[sk] || 0);
        found = true;
      }
    }
    if (found) return out;
  }
  return out;
}

function extractManualCreditEvents(log = {}) {
  const before = readByService(log?.diff?.before || log?.meta?.before || {});
  const after = readByService(log?.diff?.after || log?.meta?.after || {});
  const out = [];
  for (const sk of SERVICES) {
    const delta = Number(after[sk] || 0) - Number(before[sk] || 0);
    if (delta > 0) out.push({ type: "admin_assigned_credits", serviceKey: sk, qty: delta, createdAt: log.createdAt, logId: String(log._id || "") });
    if (delta < 0) out.push({ type: "admin_removed_credits", serviceKey: sk, qty: Math.abs(delta), createdAt: log.createdAt, logId: String(log._id || "") });
  }

  if (!out.length && Array.isArray(log?.meta?.items)) {
    for (const it of log.meta.items) {
      const sk = serviceKey(it.serviceKey || it.service || it.serviceName || "");
      const delta = Number(it.delta ?? it.credits ?? it.amount ?? 0);
      if (sk && delta > 0) out.push({ type: "admin_assigned_credits", serviceKey: sk, qty: delta, createdAt: log.createdAt, logId: String(log._id || "") });
      if (sk && delta < 0) out.push({ type: "admin_removed_credits", serviceKey: sk, qty: Math.abs(delta), createdAt: log.createdAt, logId: String(log._id || "") });
    }
  }

  return out;
}

function extractDebtEventsFromHistory(user = {}) {
  const history = Array.isArray(user.history) ? user.history : [];
  return history
    .map((h, index) => {
      const action = String(h.action || "").trim();
      const sk = serviceKey(h.serviceKey || h.service || h.serviceName || "");
      const base = {
        source: "user.history",
        action,
        serviceKey: sk,
        qty: qtyOf(h),
        date: h.date || "",
        time: h.time || "",
        title: h.title || "",
        message: h.message || "",
        appointmentId: h.appointmentId ? String(h.appointmentId) : "",
        fixedScheduleId: h.fixedScheduleId ? String(h.fixedScheduleId) : "",
        createdAt: h.createdAt || h.date || null,
        index,
      };

      if (action === "fixed_schedule_monthly_debt" || action === "fixed_schedule_debt_created") {
        return { ...base, type: "debt_created", sign: 1 };
      }

      if ([
        "fixed_schedule_debt_settled",
        "fixed_schedule_debt_settled_by_cancelled_credit",
        "fixed_schedule_debt_settled_by_plan_delete",
      ].includes(action)) {
        return { ...base, type: "debt_settled", sign: -1 };
      }

      if ([
        "fixed_schedule_debt_released_by_cancel",
        "fixed_schedule_debt_released_by_plan_delete",
      ].includes(action)) {
        return { ...base, type: "debt_released", sign: -1 };
      }

      if (action === "fixed_schedule_auto_released_unpaid") {
        return { ...base, type: "auto_release_notice", sign: 0 };
      }

      if (action === "fixed_schedule_monthly_turn_completed") {
        return { ...base, type: "fixed_turn_completed", sign: 0 };
      }

      if (action === "fixed_schedule_monthly_reserved") {
        return { ...base, type: "monthly_reserved_notice", sign: 0 };
      }

      if (action === "fixed_schedule_monthly_debit") {
        return { ...base, type: "fixed_credit_debited", sign: 0 };
      }

      return null;
    })
    .filter(Boolean);
}

function extractAppointmentDebtMarkers(appointments = []) {
  const out = emptyByService();
  const cancelledMetadata = emptyByService();

  for (const ap of appointments) {
    const sk = serviceKey(ap.serviceKey || ap.service || ap.serviceName || "");
    if (!sk) continue;

    const hasDebtMarker =
      String(ap.creditDebitStatus || "") === "debt" || Number(ap.fixedDebtAmount || 0) > 0;

    if (!hasDebtMarker) continue;

    if (["reserved", "completed"].includes(String(ap.status || ""))) {
      add(out, sk, Math.max(1, Number(ap.fixedDebtAmount || 1)));
    } else if (String(ap.status || "") === "cancelled") {
      add(cancelledMetadata, sk, Math.max(1, Number(ap.fixedDebtAmount || 1)));
    }
  }

  return { activeMarkersByService: out, cancelledMetadataByService: cancelledMetadata };
}

function explicitAutoReleasedByService(debtEvents = []) {
  const out = emptyByService();
  for (const e of debtEvents) {
    if (e.type !== "auto_release_notice") continue;
    if (!e.serviceKey) continue;
    add(out, e.serviceKey, e.qty);
  }
  return out;
}

function classifyStatus({ currentDebt, unexplainedGenerated, legacyCurrentDebt, historicalOverResolved, autoReleased }) {
  if (unexplainedGenerated > 0) return "REVISAR";
  if (currentDebt > 0 && legacyCurrentDebt > 0) return "DEUDA_LEGACY";
  if (currentDebt > 0) return "DEUDA_ACTUAL";
  if (historicalOverResolved > 0) return "HISTORICO";
  if (autoReleased > 0) return "AUTO_LIBERADO";
  return "OK";
}

function reconcile(user, { extraEvents = [], appointments = [] } = {}) {
  const cur = currentDebtByService(user);
  const created = emptyByService();
  const settled = emptyByService();
  const debtEvents = extractDebtEventsFromHistory(user);
  const autoNoticeCount = debtEvents.filter((e) => e.type === "auto_release_notice").length;

  for (const e of debtEvents) {
    if (!e.serviceKey) continue;
    if (e.sign > 0) add(created, e.serviceKey, e.qty);
    if (e.sign < 0) add(settled, e.serviceKey, e.qty);
  }

  const explicitAuto = explicitAutoReleasedByService(debtEvents);
  const autoEstimated = emptyByService();

  for (const sk of SERVICES) {
    const explicitQty = Number(explicitAuto[sk] || 0);
    if (explicitQty > 0) {
      autoEstimated[sk] = explicitQty;
      continue;
    }

    autoEstimated[sk] =
      autoNoticeCount > 0
        ? Math.max(0, Number(created[sk] || 0) - Number(settled[sk] || 0) - Number(cur[sk] || 0))
        : 0;
  }

  const expectedDebt = emptyByService();
  for (const sk of SERVICES) {
    expectedDebt[sk] = Math.max(
      0,
      Number(created[sk] || 0) -
        Number(settled[sk] || 0) -
        Number(autoEstimated[sk] || 0)
    );
  }

  const unexplainedGenerated = positiveDiff(expectedDebt, cur);
  const legacyCurrentDebt = positiveDiff(cur, expectedDebt);

  const historicalOverResolved = emptyByService();
  for (const sk of SERVICES) {
    historicalOverResolved[sk] = Math.max(
      0,
      Number(settled[sk] || 0) +
        Number(autoEstimated[sk] || 0) +
        Number(cur[sk] || 0) -
        Number(created[sk] || 0)
    );
  }

  const paidCredits = emptyByService();
  const adminAssigned = emptyByService();
  const adminRemoved = emptyByService();

  for (const e of extraEvents) {
    if (e.type === "order_paid_credits") add(paidCredits, e.serviceKey, e.qty);
    if (e.type === "admin_assigned_credits") add(adminAssigned, e.serviceKey, e.qty);
    if (e.type === "admin_removed_credits") add(adminRemoved, e.serviceKey, e.qty);
  }

  const markers = extractAppointmentDebtMarkers(appointments);

  const totals = {
    created: sumMap(created),
    settledReleased: sumMap(settled),
    autoEstimated: sumMap(autoEstimated),
    currentDebt: sumMap(cur),
    unexplained: sumMap(unexplainedGenerated),
    legacyCurrentDebt: sumMap(legacyCurrentDebt),
    historicalOverResolved: sumMap(historicalOverResolved),
    paidCredits: sumMap(paidCredits),
    adminAssignedCredits: sumMap(adminAssigned),
    adminRemovedCredits: sumMap(adminRemoved),
    autoNoticeCount,
    activeDebtMarkers: sumMap(markers.activeMarkersByService),
    cancelledDebtMetadata: sumMap(markers.cancelledMetadataByService),
  };

  const status = classifyStatus({
    currentDebt: totals.currentDebt,
    unexplainedGenerated: totals.unexplained,
    legacyCurrentDebt: totals.legacyCurrentDebt,
    historicalOverResolved: totals.historicalOverResolved,
    autoReleased: totals.autoEstimated,
  });

  return {
    status,
    currentDebtByService: cur,
    createdByService: created,
    settledReleasedByService: settled,
    autoEstimatedByService: autoEstimated,
    expectedDebtByService: expectedDebt,
    legacyCurrentDebtByService: legacyCurrentDebt,
    unexplainedGeneratedByService: unexplainedGenerated,
    historicalOverResolvedByService: historicalOverResolved,
    activeDebtMarkersByService: markers.activeMarkersByService,
    cancelledDebtMetadataByService: markers.cancelledMetadataByService,
    totals,
  };
}

async function loadUserIdsForAll() {
  const excludedObjectIds = [...EXCLUDED_USER_IDS]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const users = await mongoose.connection.db.collection("users")
    .find(excludedObjectIds.length ? { _id: { $nin: excludedObjectIds } } : {})
    .project({
      _id: 1,
      name: 1,
      lastName: 1,
      fullName: 1,
      email: 1,
      role: 1,
      fixedScheduleDebt: 1,
      history: 1,
    })
    .toArray();

  return users
    .filter((u) => !isExcludedUser(u))
    .filter((u) => {
      const hasDebt = SERVICES.some((sk) => Number(u?.fixedScheduleDebt?.[sk] || 0) > 0);
      const hasHistory = (Array.isArray(u.history) ? u.history : []).some((h) => String(h.action || "").startsWith("fixed_schedule"));
      return hasDebt || hasHistory;
    })
    .map((u) => String(u._id));
}

async function auditUser(userId, { compact = false } = {}) {
  const id = new mongoose.Types.ObjectId(userId);
  const user = await mongoose.connection.db.collection("users").findOne({ _id: id });
  if (!user) {
    console.log(`Usuario no encontrado: ${userId}`);
    return null;
  }

  if (isExcludedUser(user)) return null;

  const orders = await mongoose.connection.db.collection("orders")
    .find({ user: id })
    .sort({ createdAt: 1 })
    .toArray();

  const logs = await mongoose.connection.db.collection("activitylogs")
    .find({
      category: "users",
      action: { $in: ["credits_updated", "credit_updated"] },
      $or: [
        { entityId: String(id) },
        { "subject.id": String(id) },
        { "subject._id": String(id) },
      ],
    })
    .sort({ createdAt: 1 })
    .toArray();

  const appointments = await mongoose.connection.db.collection("appointments")
    .find({ user: id, fixedScheduleId: { $ne: null } })
    .project({
      date: 1,
      time: 1,
      service: 1,
      serviceName: 1,
      serviceKey: 1,
      status: 1,
      creditDebitStatus: 1,
      fixedDebtAmount: 1,
      fixedDebitProcessedAt: 1,
      creditLotId: 1,
      refundReason: 1,
      cancelReason: 1,
      fixedScheduleId: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .sort({ date: 1, time: 1 })
    .toArray();

  const orderEvents = orders.flatMap(extractOrderCreditEvents);
  const manualCreditEvents = logs.flatMap(extractManualCreditEvents);
  const extraEvents = [...orderEvents, ...manualCreditEvents];
  const debtEvents = extractDebtEventsFromHistory(user);
  const rec = reconcile(user, { extraEvents, appointments });

  const row = {
    id: String(user._id),
    fullName: fullName(user),
    email: user.email || "",
    ...rec,
  };

  if (compact) return row;

  console.log("\n================ AUDITORÍA DE DEUDA ================");
  console.log(`${fullName(user)} · ${user.email || "sin email"} · ${String(user._id)}`);
  console.log("Estado:", rec.status);
  console.log("Deuda actual:", rec.currentDebtByService);
  console.log("Deuda legacy actual:", rec.legacyCurrentDebtByService);
  console.log("Generó:", rec.createdByService);
  console.log("Saldó/liberó:", rec.settledReleasedByService);
  console.log("Auto liberado:", rec.autoEstimatedByService);
  console.log("Turnos activos en deuda:", rec.activeDebtMarkersByService);
  console.log("Metadata deuda cancelada:", rec.cancelledDebtMetadataByService);
  console.log("Totales:", rec.totals);

  const timeline = [
    ...debtEvents.map((e) => ({ ...e, source: "history" })),
    ...orderEvents.map((e) => ({ ...e, source: "orders", action: e.type, title: `Orden pagada ${e.serviceKey} x${e.qty}` })),
    ...manualCreditEvents.map((e) => ({ ...e, source: "activitylog", action: e.type, title: `Créditos admin/staff ${e.serviceKey} x${e.qty}` })),
  ].sort((a, b) => dateValue(a.createdAt) - dateValue(b.createdAt));

  console.log("\n--- Timeline deuda / créditos ---");
  for (const e of timeline) {
    const when = e.createdAt ? new Date(e.createdAt).toLocaleString("es-AR") : "sin fecha";
    console.log(`${when} | ${e.source} | ${e.action} | ${e.serviceKey || "-"} | qty:${e.qty || 0} | ${e.date || ""} ${e.time || ""} | ${e.title || ""}`);
  }

  console.log("\n--- Turnos fijos del usuario ---");
  for (const ap of appointments) {
    console.log(`${ap.date || ""} ${ap.time || ""} | ${serviceKey(ap.serviceKey || ap.service || ap.serviceName) || "-"} | status:${ap.status || ""} | debit:${ap.creditDebitStatus || ""} | debt:${Number(ap.fixedDebtAmount || 0)} | lot:${ap.creditLotId ? String(ap.creditLotId) : "-"} | refund:${ap.refundReason || "-"} | cancel:${ap.cancelReason || "-"}`);
  }

  return row;
}

function compactRow(r) {
  return {
    id: r.id,
    fullName: r.fullName,
    email: r.email,
    status: r.status,
    actual: r.totals.currentDebt,
    genero: r.totals.created,
    saldoLibero: r.totals.settledReleased,
    autoLiberado: r.totals.autoEstimated,
    deudaLegacyActual: r.totals.legacyCurrentDebt,
    historicoSobreConciliado: r.totals.historicalOverResolved,
    diferenciaReal: r.totals.unexplained,
    turnosDeuda: r.totals.activeDebtMarkers,
    deudaActualPorServicio: r.currentDebtByService,
    deudaLegacyPorServicio: r.legacyCurrentDebtByService,
    turnosDeudaPorServicio: r.activeDebtMarkersByService,
  };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!uri) throw new Error("No encontré MONGO_URI/MONGODB_URI/MONGO_URL en .env");
  await mongoose.connect(uri);

  const arg = process.argv[2] || "";
  if (arg === "--all" || arg === "--reviews") {
    const ids = await loadUserIdsForAll();
    const rows = [];
    for (const id of ids) {
      const row = await auditUser(id, { compact: true });
      if (row) rows.push(row);
    }

    const filtered =
      arg === "--reviews"
        ? rows.filter((r) => ["REVISAR", "DEUDA_LEGACY"].includes(r.status))
        : rows;

    console.log(JSON.stringify(filtered.map(compactRow), null, 2));
  } else if (mongoose.Types.ObjectId.isValid(arg)) {
    await auditUser(arg);
  } else {
    console.log("Uso:");
    console.log("  node scripts/auditDebtHistory.js --reviews");
    console.log("  node scripts/auditDebtHistory.js --all");
    console.log("  node scripts/auditDebtHistory.js ID_DEL_USUARIO");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
