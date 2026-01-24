import { ADMIN_EMAIL, BRAND_NAME, sendMail } from "./core.js";
import { escapeHtml, kvRow } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

/* =========================================================
   ✅ ADMISSION (Formulario completo Step2) — ADMIN + USER
========================================================= */

function safeAdmId(adm) {
  return adm?._id?.toString?.() || adm?.id || "-";
}

function cleanStr(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function formatARDateTime(dateLike) {
  try {
    const d = dateLike ? new Date(dateLike) : null;
    if (!d || Number.isNaN(d.getTime())) return { createdDate: "-", createdTime: "-" };

    const createdDate = d.toLocaleDateString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const createdTime = d.toLocaleTimeString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "2-digit",
      minute: "2-digit",
    });

    return { createdDate, createdTime };
  } catch {
    return { createdDate: "-", createdTime: "-" };
  }
}

function admissionSummary(adm = {}, user = null) {
  const s1 = adm?.step1 || {};
  const s2 = adm?.step2 || {};

  const publicId = cleanStr(adm?.publicId);
  const admissionId = safeAdmId(adm);

  const { createdDate, createdTime } = formatARDateTime(adm?.createdAt);

  const fullName =
    cleanStr(`${user?.name || ""} ${user?.lastName || ""}`.trim(), "") ||
    cleanStr(user?.fullName, "") ||
    cleanStr(s1.fullName, "-");

  const email = cleanStr(user?.email, cleanStr(s1.email));
  const phone = cleanStr(user?.phone, cleanStr(s1.phone));

  const city = s1.cityOther
    ? cleanStr(`${s1.city || ""} (${s1.cityOther})`.trim())
    : cleanStr(s1.city);

  const fitnessLevel = cleanStr(s1.fitnessLevel);
  const weight = cleanStr(s1.weight);
  const height = cleanStr(s1.height);

  const immediateGoal = cleanStr(s2.immediateGoal);
  const modality = cleanStr(s2.modality);
  const weeklySessions = cleanStr(s2.weeklySessions);
  const needsRehab = cleanStr(s2.needsRehab);

  const hasContraindication =
    s1.hasContraindication === "SI"
      ? `SI (${cleanStr(s1.contraindicationDetail)})`
      : cleanStr(s1.hasContraindication);

  const hasCondition =
    s1.hasCondition === "SI"
      ? `SI (${cleanStr(s1.conditionDetail)})`
      : cleanStr(s1.hasCondition);

  const hadInjuryLastYear =
    s1.hadInjuryLastYear === "SI"
      ? `SI (${cleanStr(s1.injuryDetail)})`
      : cleanStr(s1.hadInjuryLastYear);

  const relevantInfo = cleanStr(s1.relevantInfo);

  return {
    admissionId,
    publicId,
    createdDate,
    createdTime,
    fullName,
    email,
    phone,
    city,
    fitnessLevel,
    weight,
    height,
    hasContraindication,
    hasCondition,
    hadInjuryLastYear,
    relevantInfo,
    immediateGoal,
    modality,
    weeklySessions,
    needsRehab,
  };
}

/* =========================================================
   ADMIN email
========================================================= */
export async function sendAdminAdmissionCompletedEmail(admissionDoc = {}, pseudoUser = null) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const s = admissionSummary(admissionDoc, pseudoUser);

  console.log("[MAIL][ADM] admin completed ->", {
    to,
    publicId: s.publicId,
    admissionId: s.admissionId,
    fullName: s.fullName,
    userEmail: s.email,
  });

  const subject = `🧾 Formulario completo (Admisión) — ${s.fullName} · #${s.publicId}`;

  const text = [
    "Formulario de admisión completado (Step2)",
    "",
    `PublicId: ${s.publicId}`,
    `AdmissionId: ${s.admissionId}`,
    `Creado: ${s.createdDate} ${s.createdTime}`,
    "",
    `Nombre: ${s.fullName}`,
    `Email: ${s.email}`,
    `Tel: ${s.phone}`,
    `Ciudad: ${s.city}`,
    "",
    `Fitness: ${s.fitnessLevel}`,
    `Altura: ${s.height}`,
    `Peso: ${s.weight}`,
    "",
    `Contraindicación: ${s.hasContraindication}`,
    `Condición: ${s.hasCondition}`,
    `Lesión último año: ${s.hadInjuryLastYear}`,
    `Info relevante: ${s.relevantInfo}`,
    "",
    `Step2 · Rehab: ${s.needsRehab}`,
    `Step2 · Objetivo: ${s.immediateGoal}`,
    `Step2 · Modalidad: ${s.modality}`,
    `Step2 · Sesiones/sem: ${s.weeklySessions}`,
  ].join("\n");

  const bodyHtml = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:800;">Formulario completado</div>
      <div style="margin-left:auto; background:#e9f7ef; color:#0b6b2a; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        COMPLETO
      </div>
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("PublicId", `#${escapeHtml(s.publicId)}`)}
        ${kvRow("AdmissionId", escapeHtml(s.admissionId))}
        ${kvRow("Creado", escapeHtml(`${s.createdDate} ${s.createdTime}`))}
        ${kvRow("Nombre", escapeHtml(s.fullName))}
        ${kvRow("Email", escapeHtml(s.email))}
        ${kvRow("Teléfono", escapeHtml(s.phone))}
        ${kvRow("Ciudad", escapeHtml(s.city))}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:800;">Resumen Step1</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Fitness", escapeHtml(s.fitnessLevel))}
        ${kvRow("Altura", escapeHtml(s.height))}
        ${kvRow("Peso", escapeHtml(s.weight))}
        ${kvRow("Contraindicación", escapeHtml(s.hasContraindication))}
        ${kvRow("Condición", escapeHtml(s.hasCondition))}
        ${kvRow("Lesión último año", escapeHtml(s.hadInjuryLastYear))}
        ${kvRow("Info relevante", escapeHtml(s.relevantInfo))}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:800;">Resumen Step2</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Rehab", escapeHtml(s.needsRehab))}
        ${kvRow("Objetivo", escapeHtml(s.immediateGoal))}
        ${kvRow("Modalidad", escapeHtml(s.modality))}
        ${kvRow("Sesiones/sem", escapeHtml(s.weeklySessions))}
      </table>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Admisión completada`,
    preheader: `Admisión #${s.publicId} · ${s.fullName}`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   USER email
========================================================= */
export async function sendUserAdmissionReceivedEmail(admissionDoc = {}, pseudoUser = null) {
  const email = cleanStr(pseudoUser?.email || admissionDoc?.step1?.email, "").trim();
  if (!email) return;

  const s = admissionSummary(admissionDoc, pseudoUser);

  console.log("[MAIL][ADM] user received ->", {
    to: email,
    publicId: s.publicId,
    admissionId: s.admissionId,
    fullName: s.fullName,
  });

  const helloName = cleanStr(pseudoUser?.name, "") || cleanStr(s.fullName, "Hola");

  const subject = `✅ Recibimos tu formulario - ${BRAND_NAME}`;

  const text = [
    `Hola ${helloName},`,
    "",
    "Recibimos tu formulario correctamente.",
    "",
    `Código: #${s.publicId}`,
    "",
    "En breve el staff lo revisa y te contacta si hace falta.",
  ].join("\n");

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">Formulario recibido</div>

    <div style="color:#333; margin-bottom:12px;">
      Hola <b>${escapeHtml(helloName)}</b>, recibimos tu formulario correctamente.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Código", `#${escapeHtml(s.publicId)}`)}
        ${kvRow("Nombre", escapeHtml(s.fullName))}
        ${kvRow("Email", escapeHtml(s.email))}
        ${kvRow("Teléfono", escapeHtml(s.phone))}
      </table>
    </div>

    <div style="margin-top:14px; font-size:12px; color:#666;">
      En breve el staff lo revisa. Si hace falta, te contactamos por WhatsApp o email.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Formulario recibido`,
    preheader: `Recibimos tu formulario · Código #${s.publicId}`,
    bodyHtml,
  });

  await sendMail(email, subject, text, html);
}
