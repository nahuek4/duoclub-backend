import User from "../models/User.js";
import { sendMail } from "../mail/core.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVERY_MINUTES = 360;

function addDays(date, days) {
  const d = new Date(date || Date.now());
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function startDateForUser(user) {
  return (
    user?.medicalClearance?.startedAt ||
    user?.welcomeApprovedEmailSentAt ||
    user?.createdAt ||
    new Date()
  );
}

function fullName(user) {
  return `${String(user?.name || "").trim()} ${String(user?.lastName || "").trim()}`.trim() || "alumno/a";
}

function daysSince(date, now = new Date()) {
  const start = new Date(date || now);
  if (Number.isNaN(start.getTime())) return 0;
  return Math.floor((now.getTime() - start.getTime()) / DAY_MS);
}

function ensureMedicalClearance(user, now = new Date()) {
  if (!user.medicalClearance || typeof user.medicalClearance !== "object") {
    const startedAt = startDateForUser(user);
    user.medicalClearance = {
      status: "not_submitted",
      startedAt,
      dueAt: addDays(startedAt, 30),
      approvedAt: null,
      rejectedAt: null,
      suspendedAt: null,
      lastReminder10At: null,
      lastReminder20At: null,
      lastReminder30At: null,
      lastCheckedAt: null,
      notes: "",
    };
  }

  if (!user.medicalClearance.startedAt) {
    user.medicalClearance.startedAt = startDateForUser(user);
  }

  if (!user.medicalClearance.dueAt) {
    user.medicalClearance.dueAt = addDays(user.medicalClearance.startedAt, 30);
  }

  user.medicalClearance.lastCheckedAt = now;
  return user.medicalClearance;
}

function isApproved(user) {
  const st = String(user?.medicalClearance?.status || user?.aptoStatus || "")
    .toLowerCase()
    .trim();

  return (
    st === "approved" ||
    !!user?.medicalClearance?.approvedAt ||
    !!user?.aptoCompletedAt ||
    String(user?.aptoPath || "") === "ADMIN_COMPLETED_APTO"
  );
}

function buildReminderText(user, reminderDay) {
  const name = fullName(user);

  if (reminderDay === 10) {
    return {
      subject: "Recordatorio de apto físico - DUO",
      text: [
        `Hola ${name},`,
        "",
        "Te recordamos que la entrega del apto físico es muy importante para cuidarte y cuidarnos.",
        "Te quedan 20 días para presentarlo; caso contrario debemos suspender tu membresía hasta que regularices tu situación.",
        "",
        "DUO Health Club",
      ].join("\n"),
    };
  }

  if (reminderDay === 20) {
    return {
      subject: "Te quedan 10 días para presentar tu apto físico - DUO",
      text: [
        `Hola ${name},`,
        "",
        "Te recordamos que la entrega del apto físico es muy importante para cuidarte y cuidarnos.",
        "Te quedan solo 10 días para presentarlo; caso contrario debemos suspender tu membresía hasta que regularices tu situación.",
        "",
        "DUO Health Club",
      ].join("\n"),
    };
  }

  return {
    subject: "Último aviso de apto físico - DUO",
    text: [
      `Hola ${name},`,
      "",
      "Llegamos al límite de tiempo para la presentación de tu apto médico y aún no lo recibimos.",
      "Recordá que el último sábado de cada mes podés hacerlo en DUO con nuestro cardiólogo; caso contrario la semana próxima, lamentablemente debemos suspender tu membresía.",
      "",
      "DUO Health Club",
    ].join("\n"),
  };
}

async function sendReminder(user, reminderDay) {
  const to = String(user?.email || "").trim();
  if (!to) return false;

  const { subject, text } = buildReminderText(user, reminderDay);
  const html = `<div style="font-family:Arial,sans-serif;color:#111;line-height:1.5;">
    <p>${text.replace(/\n/g, "<br>")}</p>
  </div>`;

  await sendMail(to, subject, text, html);
  return true;
}

async function maybeSendReminder(user, reminderDay, field, now) {
  const mc = ensureMedicalClearance(user, now);
  if (mc[field]) return false;

  try {
    const sent = await sendReminder(user, reminderDay);
    if (!sent) return false;

    mc[field] = now;
    user.history = Array.isArray(user.history) ? user.history : [];
    user.history.push({
      action: `medical_clearance_reminder_${reminderDay}`,
      title: `Recordatorio apto físico día ${reminderDay}`,
      message: `Se envió por mail el recordatorio de apto físico correspondiente al día ${reminderDay}.`,
      createdAt: now,
    });
    return true;
  } catch (e) {
    console.log(`[MEDICAL] reminder ${reminderDay} failed`, {
      userId: String(user?._id || ""),
      email: user?.email || "",
      error: e?.message || e,
    });
    return false;
  }
}

function suspendForMedicalClearance(user, now) {
  const mc = ensureMedicalClearance(user, now);

  if (mc.status === "approved") return false;
  if (user.suspended && String(user.suspendedReason || "") === "medical_clearance") return false;

  mc.status = "suspended";
  mc.suspendedAt = mc.suspendedAt || now;
  mc.lastCheckedAt = now;

  user.suspended = true;
  user.suspendedReason = "medical_clearance";
  user.suspendedAt = user.suspendedAt || now;

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "medical_clearance_auto_suspended",
    title: "Membresía suspendida por apto físico",
    message: "Se suspendió automáticamente la posibilidad de reservar por no presentar apto físico desde el día 31 de alta.",
    createdAt: now,
  });

  return true;
}

async function processUser(user, now = new Date()) {
  const mc = ensureMedicalClearance(user, now);

  if (isApproved(user)) {
    if (mc.status !== "approved") {
      mc.status = "approved";
      mc.approvedAt = mc.approvedAt || user.aptoCompletedAt || now;
    }
    if (user.suspended && String(user.suspendedReason || "") === "medical_clearance") {
      user.suspended = false;
      user.suspendedReason = "";
      user.suspendedAt = null;
    }
    await user.save();
    return { changed: true, status: "approved" };
  }

  const days = daysSince(mc.startedAt || user.createdAt, now);
  let changed = false;

  if (days >= 10) changed = (await maybeSendReminder(user, 10, "lastReminder10At", now)) || changed;
  if (days >= 20) changed = (await maybeSendReminder(user, 20, "lastReminder20At", now)) || changed;
  if (days >= 30) changed = (await maybeSendReminder(user, 30, "lastReminder30At", now)) || changed;
  if (days >= 31) changed = suspendForMedicalClearance(user, now) || changed;

  mc.lastCheckedAt = now;

  if (changed) await user.save();
  else if (user.isModified?.("medicalClearance")) await user.save();

  return { changed, status: mc.status || "not_submitted", days };
}

export async function runMedicalClearanceCheck() {
  const now = new Date();

  const users = await User.find({
    role: { $in: ["client"] },
    approvalStatus: "approved",
  });

  let checked = 0;
  let changed = 0;

  for (const user of users) {
    checked += 1;
    try {
      const result = await processUser(user, now);
      if (result?.changed) changed += 1;
    } catch (e) {
      console.log("[MEDICAL] user check failed", {
        userId: String(user?._id || ""),
        email: user?.email || "",
        error: e?.message || e,
      });
    }
  }

  console.log("[MEDICAL] tick", { checked, changed });
  return { checked, changed };
}

export function startMedicalClearanceScheduler({ everyMinutes = DEFAULT_EVERY_MINUTES } = {}) {
  const minutes = Math.max(30, Number(everyMinutes || DEFAULT_EVERY_MINUTES));

  console.log("[MEDICAL] scheduler starting", { everyMinutes: minutes });

  setTimeout(() => {
    runMedicalClearanceCheck().catch((e) => {
      console.log("[MEDICAL] initial tick error", e?.message || e);
    });
  }, 30 * 1000);

  setInterval(() => {
    runMedicalClearanceCheck().catch((e) => {
      console.log("[MEDICAL] tick error", e?.message || e);
    });
  }, minutes * 60 * 1000);
}
