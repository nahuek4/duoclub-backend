// backend/src/mail/admissionEmails.js
import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import {
  buildExactMail,
  renderExactBodyText,
  renderPrimaryButton,
  renderAdminMetaPanel,
  renderAdminDetailPanel,
  renderRowCard,
  renderUnifiedMailFooter,
} from "./ui.js";

const MAIL_ASSET_BASE = `${BRAND_URL.replace(/\/$/, "")}/images`;
const MAIL_LOGO_URL = `${MAIL_ASSET_BASE}/logo.png`;
const MAIL_CHECK_URL = `${MAIL_ASSET_BASE}/iconocheck.png`;
const MAIL_WORDMARK_URL = `${MAIL_ASSET_BASE}/duohealthclub.png`;

function renderMailHeaderLogo(width = 34) {
  return `<img src="${escapeHtml(MAIL_LOGO_URL)}" alt="${escapeHtml(BRAND_NAME)}" width="${Number(width) || 34}" style="display:block; margin:0 auto; width:${Number(width) || 34}px; max-width:${Number(width) || 34}px; height:auto;" />`;
}

function renderMailCheckIcon(size = 18) {
  return `<img src="${escapeHtml(MAIL_CHECK_URL)}" alt="Check" width="${Number(size) || 18}" height="${Number(size) || 18}" style="display:block; width:${Number(size) || 18}px; height:${Number(size) || 18}px;" />`;
}

function renderMailFooterBrand(width = 92) {
  return `<img src="${escapeHtml(MAIL_WORDMARK_URL)}" alt="${escapeHtml(BRAND_NAME)}" width="${Number(width) || 92}" style="display:block; width:${Number(width) || 92}px; max-width:100%; height:auto;" />`;
}

function renderMailFooterIcons() {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:8px;">
      <tr>
        <td style="padding-right:6px;">
          <div style="width:20px; height:20px; border-radius:999px; border:1px solid #ffffff; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:8px; line-height:20px; text-align:center; font-weight:700;">ig</div>
        </td>
        <td style="padding-right:6px;">
          <div style="width:20px; height:20px; border-radius:999px; border:1px solid #ffffff; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:10px; line-height:20px; text-align:center; font-weight:700;">f</div>
        </td>
        <td>
          <div style="width:20px; height:20px; border-radius:999px; border:1px solid #ffffff; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:8px; line-height:20px; text-align:center; font-weight:700;">in</div>
        </td>
      </tr>
    </table>
  `;
}


/* =========================================================
   Helpers
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
    if (!d || Number.isNaN(d.getTime())) {
      return { createdDate: "-", createdTime: "-" };
    }

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

  const healthInsuranceProvider = cleanStr(s1.healthInsuranceProvider);

  const birth =
    s1.birthDay && s1.birthMonth && s1.birthYear
      ? `${cleanStr(s1.birthDay)} / ${cleanStr(s1.birthMonth)} / ${cleanStr(
          s1.birthYear
        )}`
      : "-";

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

  const diabetes =
    s1.diabetes === "SI"
      ? `SI (${cleanStr(s1.diabetesType)})`
      : cleanStr(s1.diabetes);

  const smokes =
    s1.smokes === "SI"
      ? `SI (${cleanStr(s1.cigarettesPerDay)} cig/día)`
      : cleanStr(s1.smokes);

  const heartProblems =
    s1.heartProblems === "SI"
      ? `SI (${cleanStr(s1.heartDetail)})`
      : cleanStr(s1.heartProblems);

  const oncologicTreatment = cleanStr(s1.oncologicTreatment);

  const orthoProblem =
    s1.orthoProblem === "SI"
      ? `SI (${cleanStr(s1.orthoDetail)})`
      : cleanStr(s1.orthoProblem);

  const pregnant =
    s1.pregnant === "SI"
      ? `SI (${cleanStr(s1.pregnantWeeks)} semanas)`
      : cleanStr(s1.pregnant);

  const needsRehab = cleanStr(s2.needsRehab);

  const rehab_hasDiagnosisOrder =
    needsRehab !== "SI"
      ? "N/A"
      : s2.hasDiagnosisOrder === "SI"
      ? `SI (${cleanStr(s2.diagnosisOrderDetail)})`
      : cleanStr(s2.hasDiagnosisOrder);

  const rehab_symptoms = needsRehab !== "SI" ? "N/A" : cleanStr(s2.symptoms);

  const rehab_symptomDate =
    needsRehab !== "SI" ? "N/A" : cleanStr(s2.symptomStartDate);

  const rehab_medicalConsult =
    needsRehab !== "SI"
      ? "N/A"
      : s2.medicalConsult === "SI"
      ? `SI (${cleanStr(s2.medicalConsultWhen)})`
      : cleanStr(s2.medicalConsult);

  const rehab_diagnosticStudy =
    needsRehab !== "SI"
      ? "N/A"
      : s2.diagnosticStudy === "OTRO"
      ? `OTRO (${cleanStr(s2.diagnosticStudyOther)})`
      : cleanStr(s2.diagnosticStudy);

  const rehab_howHappened =
    needsRehab !== "SI" ? "N/A" : cleanStr(s2.incidentHow);

  const rehab_dailyDiscomfort =
    needsRehab !== "SI" ? "N/A" : cleanStr(s2.dailyDiscomfort);

  const rehab_mobilityIssue =
    needsRehab !== "SI" ? "N/A" : cleanStr(s2.mobilityIssue);

  const rehab_takesMedication =
    needsRehab !== "SI"
      ? "N/A"
      : s2.takesMedication === "SI"
      ? `SI (${cleanStr(s2.medicationDetail)})`
      : cleanStr(s2.takesMedication);

  const practicesCompetitiveSport = cleanStr(s2.practicesCompetitiveSport);

  const competitionLevel = "N/A";
  const sportName = "N/A";
  const sportPosition = "N/A";

  const immediateGoal = cleanStr(s2.immediateGoal);

  const trainAlone =
    s2.trainAlone === "SOMOS"
      ? `SOMOS (${cleanStr(s2.trainWithCount)})`
      : cleanStr(s2.trainAlone);

  const idealSchedule = cleanStr(s2.idealTimeRange);
  const preferredDays = cleanStr(s2.preferredDays);
  const weeklySessions = cleanStr(s2.weeklySessions);
  const modality = cleanStr(s2.modality);

  const acceptsConsent =
    s2.acceptedTerms === true
      ? "SI"
      : s2.acceptedTerms === false
      ? "NO"
      : cleanStr(s2.acceptedTerms);

  // Los formularios nuevos guardan la salud y el deporte en step2.
  // Se respetan los datos de las admisiones anteriores como respaldo.
  const isPerformance = String(adm?.formType || s1.formType || "").toUpperCase() === "PERFORMANCE" ||
    ["RECOVERY", "TRAINING"].includes(String(s1.performanceGoal || s2.performanceGoal || "").toUpperCase());
  const performanceGoal = String(s1.performanceGoal || s2.performanceGoal || "").toUpperCase();
  const yn = (v, detail = "") => v === "SI" && detail ? `SI (${cleanStr(detail)})` : cleanStr(v);
  const newValues = isPerformance ? {
    formLabel: performanceGoal === "RECOVERY" ? "Necesito recuperarme" : performanceGoal === "TRAINING" ? "Necesito entrenar" : "Performance",
    healthInsurancePlan: cleanStr(s1.healthInsurancePlan),
    consultationReason: cleanStr(s2.consultationReason),
    injuryDate: s2.injuryDateUnknown ? "No recuerdo" : cleanStr(s2.injuryDate),
    symptomStartDate: s2.symptomStartUnknown ? "No recuerdo" : cleanStr(s2.symptomStartDate),
    medicalReferral: cleanStr(s2.medicalReferral),
    doctorName: cleanStr(s2.doctorName),
    medicalOrderDate: s2.noMedicalOrder ? "No tengo orden médica" : cleanStr(s2.medicalOrderDate),
    diagnosticStudies: Array.isArray(s2.diagnosticStudies) ? s2.diagnosticStudies.map(x => x === "OTRO" ? `Otro (${cleanStr(s2.diagnosticStudyOther)})` : x).join(", ") : "-",
    discomfortScale: cleanStr(s2.discomfortScale),
    mobilityLimitation: cleanStr(s2.mobilityLimitation),
    heartDifficulty: yn(s2.heartDifficulty, s2.heartDifficultyDetail),
    diabetesNew: yn(s2.diabetes, s2.diabetesType),
    bloodPressureNew: cleanStr(s2.bloodPressure),
    pregnantNew: yn(s2.pregnant, s2.pregnantWeeks ? `${s2.pregnantWeeks} semanas` : ""),
    contraindicationNew: yn(s2.hasContraindication, s2.contraindicationDetail),
    oncologicProcess: cleanStr(s2.oncologicProcess),
    medicationNew: yn(s2.takesMedication, s2.medicationDetail),
    injuryNew: yn(s2.hadInjuryLastYear, s2.injuryDetail),
    regularSport: cleanStr(s2.regularSport),
    sportNameNew: cleanStr(s2.sportName || s2.competitiveSportName),
    sportLevelNew: cleanStr(s2.sportLevel || s2.currentSportLevel),
    positionNew: cleanStr(s2.position),
    lastNormalTraining: cleanStr(s2.lastNormalTraining || s2.lastRegularTraining),
    lastMedicalExamNew: cleanStr(s2.lastMedicalExam),
    performanceCondition: yn(s2.performanceCondition, s2.performanceConditionDetail),
    smokesNew: yn(s2.smokes, s2.cigarettesPerDay ? `${s2.cigarettesPerDay} cigarrillos diarios` : ""),
    fitnessLevelNew: cleanStr(s2.fitnessLevel),
    chronicPain: yn(s2.chronicPain, s2.chronicPainDetail),
    competitiveSport: cleanStr(s2.competitiveSport),
    weeklySportHours: cleanStr(s2.weeklySportHours),
  } : { formLabel: "Admisión", healthInsurancePlan: cleanStr(s1.healthInsurancePlan) };

  return {
    admissionId,
    ...newValues,
    isPerformance,
    performanceGoal,
    publicId,
    createdDate,
    createdTime,
    fullName,
    email,
    phone,
    city,
    healthInsuranceProvider,
    birth,
    height: cleanStr(s1.height),
    weight: cleanStr(s1.weight),
    fitnessLevel: cleanStr(s1.fitnessLevel),
    hasContraindication,
    lastSupervisedTraining: cleanStr(s1.lastSupervisedTraining),
    lastMedicalExam: cleanStr(s1.lastMedicalExam),
    hasPain: cleanStr(s1.hasPain),
    hasCondition,
    hadInjuryLastYear,
    diabetes,
    bloodPressure: cleanStr(s1.bloodPressure),
    smokes,
    heartProblems,
    oncologicTreatment,
    orthoProblem,
    pregnant,
    lastBloodTest: cleanStr(s1.lastBloodTest),
    relevantInfo: cleanStr(s1.relevantInfo),
    needsRehab,
    rehab_hasDiagnosisOrder,
    rehab_symptoms,
    rehab_symptomDate,
    rehab_medicalConsult,
    rehab_diagnosticStudy,
    rehab_howHappened,
    rehab_dailyDiscomfort,
    rehab_mobilityIssue,
    rehab_takesMedication,
    practicesCompetitiveSport,
    competitionLevel,
    sportName,
    sportPosition,
    immediateGoal,
    trainAlone,
    idealSchedule,
    preferredDays,
    weeklySessions,
    modality,
    acceptsConsent,
  };
}

function renderSectionPanel(title, rows = []) {
  const valid = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.label && r.value !== undefined && r.value !== null
  );

  const cards = valid.length
    ? valid
        .map((row) =>
          renderRowCard({
            titleLeft: row.label,
            titleRight: "",
            subtitle: `<span style="color:#ffffff;">${escapeHtml(
              String(row.value)
            )}</span>`,
          })
        )
        .join("")
    : `
      <div style="
        font-size:14px;
        line-height:18px;
        font-weight:700;
        color:#ffffff;
        text-align:left;
      ">
        Sin datos para mostrar.
      </div>
    `;

  return `
    ${renderExactBodyText(escapeHtml(title), {
      fontSize: 13,
      lineHeight: 18,
      weight: 900,
      maxWidth: 340,
      marginTop: 2,
      marginBottom: 10,
      textAlign: "left",
    })}
    <div
      class="panel"
      style="
        background:#0a0a0a;
        border-radius:6px;
        padding:14px;
        margin:0 auto 18px;
        max-width:100%;
        text-align:left;
      "
    >
      ${cards}
    </div>
  `;
}

function buildAdmissionEmail({ title, preheader, icon = "✓", innerHtml }) {
  const safeTitle = escapeHtml(title).replace(/\n/g, "<br />");
  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title.replace(/\n/g, " ")}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width:560px) {
          .adm-mail-card { border-radius:22px !important; }
          .adm-mail-body { padding:24px 22px 30px !important; }
          .adm-mail-title { font-size:25px !important; line-height:30px !important; }
        }
      </style>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr><td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="adm-mail-card" style="max-width:410px;border-collapse:separate;border-spacing:0;background:#FBFBFB;border-radius:28px;overflow:hidden;">
            <tr><td style="background:#0A0A0A;padding:22px 23px 26px;text-align:left;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
                <td align="left" valign="top">${renderMailCheckIcon(34)}</td>
                <td align="right" valign="top">${renderMailHeaderLogo(34)}</td>
              </tr></table>
              <div class="adm-mail-title" style="padding-top:20px;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:29px;line-height:34px;letter-spacing:-.7px;font-weight:750;text-align:left;">${safeTitle}</div>
            </td></tr>
            <tr><td class="adm-mail-body" style="padding:27px 26px 30px;font-family:Arial,Helvetica,sans-serif;color:#111111;text-align:center;">
              ${innerHtml}
            </td></tr>
            ${renderUnifiedMailFooter({ className: "adm-mail-footer" })}
          </table>
        </td></tr>
      </table>
    `,
  });
}


function buildAdminAdmissionVisualEmail({
  title,
  preheader,
  heading,
  introHtml,
  bodyHtml,
}) {
  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width: 560px) {
          .duo-admin-wrap { max-width: 100% !important; }
          .duo-admin-card { border-radius: 0 0 22px 22px !important; }
          .duo-admin-content { padding: 30px 26px 34px !important; }
          .duo-admin-heading { font-size: 22px !important; line-height: 26px !important; }
          .duo-admin-copy { font-size: 14px !important; line-height: 21px !important; }
          .duo-admin-footer { padding: 36px 32px 38px !important; border-radius: 0 0 22px 22px !important; }
          .duo-footer-brand { font-size: 22px !important; line-height: 22px !important; letter-spacing: 6px !important; }
          .duo-footer-info { font-size: 9px !important; line-height: 13px !important; }
        }
      </style>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr><td align="center" style="padding:0;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="duo-admin-wrap" style="max-width:430px; border-collapse:separate; border-spacing:0;">
            <tr><td class="duo-admin-card" style="background:#ffffff; border-radius:0 0 28px 28px; overflow:hidden; font-family:Arial, Helvetica, sans-serif; color:#111111;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                <tr>
                  <td class="duo-admin-content" style="padding:34px 28px 34px; background:#ffffff; color:#111111;">
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                      <tr><td align="center" style="padding:0 0 36px;">${renderMailHeaderLogo()}</td></tr>
                      <tr><td style="padding:0 0 14px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;"><tr><td valign="middle" style="width:24px; padding:0 10px 0 0;"><div style="width:19px; height:19px; border:2px solid #111111; border-radius:999px; font-size:11px; line-height:17px; text-align:center; font-weight:900; color:#111111;">✓</div></td><td class="duo-admin-heading" valign="middle" style="font-size:24px; line-height:28px; font-weight:900; color:#111111; letter-spacing:-0.6px;">${escapeHtml(heading)}</td></tr></table></td></tr>
                      <tr><td style="padding:0 0 16px;"><div style="height:1px; background:#c9c9c9; width:100%;"></div></td></tr>
                      <tr><td class="duo-admin-copy" style="font-size:14px; line-height:20px; font-weight:400; color:#111111; text-align:left; padding:0 0 18px;">${introHtml}</td></tr>
                      <tr><td>${bodyHtml}</td></tr>
                    </table>
                  </td>
                </tr>
                                 ${renderUnifiedMailFooter({ className: "duo-admin-footer" })}
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>
    `,
  });
}

/* =========================================================
   ADMIN email
========================================================= */

export async function sendAdminAdmissionCompletedEmail(
  admissionDoc = {},
  pseudoUser = null,
  options = {}
) {
  const to = String(options?.to || ADMIN_EMAIL || "").trim();
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
    "Formulario de admisión completado (Step1 + Step2)",
    `Tipo de consulta: ${s.formLabel}`,
    "",
    `Código: #${s.publicId}`,
    `AdmissionId: ${s.admissionId}`,
    `Creado: ${s.createdDate} ${s.createdTime}`,
    "",
    "=== DATOS DE CONTACTO ===",
    `Nombre: ${s.fullName}`,
    `Email: ${s.email}`,
    `Tel: ${s.phone}`,
    `Obra social / prepaga: ${s.healthInsuranceProvider}`,
    `Ciudad: ${s.city}`,
    "",
    "=== STEP 1 · DATOS PERSONALES / FÍSICO / SALUD ===",
    `Fecha nacimiento: ${s.birth}`,
    `Altura: ${s.height}`,
    `Peso: ${s.weight}`,
    `Condición física actual: ${s.fitnessLevel}`,
    `Contraindicación médica: ${s.hasContraindication}`,
    `Último entrenamiento supervisado: ${s.lastSupervisedTraining}`,
    `Último examen médico: ${s.lastMedicalExam}`,
    `Dolor habitual: ${s.hasPain}`,
    `Enfermedad que condicione rendimiento: ${s.hasCondition}`,
    `Lesión último año: ${s.hadInjuryLastYear}`,
    `Diabetes: ${s.diabetes}`,
    `Presión arterial: ${s.bloodPressure}`,
    `Fumás: ${s.smokes}`,
    `Problemas cardíacos: ${s.heartProblems}`,
    `Tratamiento oncológico: ${s.oncologicTreatment}`,
    `Problema ortopédico: ${s.orthoProblem}`,
    `Embarazada: ${s.pregnant}`,
    `Último análisis de sangre: ${s.lastBloodTest}`,
    `Información relevante: ${s.relevantInfo}`,
    "",
    "=== STEP 2 · REHABILITACIÓN ===",
    `Necesita rehabilitación: ${s.needsRehab}`,
    `Diagnóstico y orden médica: ${s.rehab_hasDiagnosisOrder}`,
    `Síntomas: ${s.rehab_symptoms}`,
    `Fecha lesión/aparición síntomas: ${s.rehab_symptomDate}`,
    `Consulta médica: ${s.rehab_medicalConsult}`,
    `Estudios de diagnóstico: ${s.rehab_diagnosticStudy}`,
    `Cómo sucedió: ${s.rehab_howHappened}`,
    `Malestar diario: ${s.rehab_dailyDiscomfort}`,
    `Imposibilidad para desplazarte: ${s.rehab_mobilityIssue}`,
    `Toma medicación: ${s.rehab_takesMedication}`,
    "",
    "=== STEP 2 · ACTUALIDAD DEPORTIVA ===",
    `Deporte competitivo: ${s.practicesCompetitiveSport}`,
    `Nivel: ${s.competitionLevel}`,
    `Deporte: ${s.sportName}`,
    `Puesto: ${s.sportPosition}`,
    "",
    "=== STEP 2 · NUEVO PLAN ===",
    `Objetivo inmediato: ${s.immediateGoal}`,
    `Entrenaría solo/a: ${s.trainAlone}`,
    `Rango horario ideal: ${s.idealSchedule}`,
    `Días preferenciales: ${s.preferredDays}`,
    `Sesiones semanales: ${s.weeklySessions}`,
    `Modalidad: ${s.modality}`,
    "",
    "=== CONSENTIMIENTO ===",
    `Aceptó términos: ${s.acceptsConsent}`,
  ].join("\n");

  const html = buildAdminAdmissionVisualEmail({
    title: "Formulario completo",
    preheader: `Admisión completa #${s.publicId}`,
    heading: "Formulario completo",
    introHtml: `Se completó un formulario de admisión de <b>${escapeHtml(s.fullName)}</b>.<br />Revisá toda la información cargada a continuación.`,
    bodyHtml: s.isPerformance ? `
      ${renderAdminMetaPanel([{ label: "Código", value: `#${s.publicId}` }, { label: "Tipo de consulta", value: s.formLabel }])}
      ${renderSectionPanel("Datos personales", [
        { label: "Nombre", value: s.fullName }, { label: "Email", value: s.email },
        { label: "Teléfono", value: s.phone }, { label: "Fecha de nacimiento", value: s.birth },
        { label: "Altura (cm)", value: s.height }, { label: "Peso (kg)", value: s.weight },
        { label: "Obra social", value: s.healthInsuranceProvider }, { label: "Plan", value: s.healthInsurancePlan },
      ])}
      ${s.performanceGoal === "RECOVERY" ? renderSectionPanel("Acerca de tu consulta", [
        { label: "Motivo", value: s.consultationReason }, { label: "Fecha lesión", value: s.injuryDate },
        { label: "Comienzo síntomas", value: s.symptomStartDate }, { label: "Derivación médica", value: s.medicalReferral },
        { label: "Médico", value: s.doctorName }, { label: "Orden médica", value: s.medicalOrderDate },
        { label: "Estudios", value: s.diagnosticStudies }, { label: "Malestar (1–10)", value: s.discomfortScale },
        { label: "Movilidad", value: s.mobilityLimitation },
      ]) : ""}
      ${renderSectionPanel("Salud general", [
        ...(s.performanceGoal === "RECOVERY" ? [{label:"Dificultad cardíaca",value:s.heartDifficulty}] : [{label:"Último examen médico",value:s.lastMedicalExamNew}, {label:"Condición que afecte rendimiento",value:s.performanceCondition}, {label:"Fuma",value:s.smokesNew}]),
        {label:"Diabetes",value:s.diabetesNew}, {label:"Presión arterial",value:s.bloodPressureNew},
        {label:"Embarazo",value:s.pregnantNew}, {label:"Contraindicación",value:s.contraindicationNew},
        {label:"Proceso oncológico",value:s.oncologicProcess},
        ...(s.performanceGoal === "RECOVERY" ? [{label:"Medicación",value:s.medicationNew}] : []),
        {label:"Lesiones último año",value:s.injuryNew},
      ])}
      ${renderSectionPanel("Condición física y deporte", [
        ...(s.performanceGoal === "RECOVERY" ? [{label:"Práctica habitual",value:s.regularSport}] : [{label:"Condición física",value:s.fitnessLevelNew},{label:"Dolor crónico",value:s.chronicPain},{label:"Deporte competitivo",value:s.competitiveSport}]),
        {label:"Deporte",value:s.sportNameNew}, {label:"Nivel",value:s.sportLevelNew},
        {label:"Posición",value:s.positionNew}, {label:"Último entrenamiento normal",value:s.lastNormalTraining},
        ...(s.performanceGoal === "TRAINING" ? [{label:"Horas semanales",value:s.weeklySportHours}] : []),
      ])}
      ${renderSectionPanel("Nuevo plan", [
        {label:"Objetivos",value:s.immediateGoal},{label:"Días preferenciales",value:s.preferredDays},
        {label:"Rango horario",value:s.idealSchedule},{label:"Sesiones semanales",value:s.weeklySessions},
        {label:"Aceptó términos",value:s.acceptsConsent},
      ])}
    ` : `
      ${renderAdminMetaPanel([
        { label: "Código", value: `#${s.publicId}` },
        { label: "AdmissionId", value: s.admissionId },
      ])}

      ${renderAdminDetailPanel([
        { label: "Creado", value: `${s.createdDate} ${s.createdTime}` },
        { label: "Nombre", value: s.fullName },
        { label: "Email", value: s.email },
        { label: "Teléfono", value: s.phone },
        { label: "Obra social / prepaga", value: s.healthInsuranceProvider },
        { label: "Ciudad", value: s.city },
      ])}

      ${renderSectionPanel("Step 1 · Datos personales / físico / salud", [
        { label: "Fecha nacimiento", value: s.birth },
        { label: "Altura", value: s.height },
        { label: "Peso", value: s.weight },
        { label: "Obra social / prepaga", value: s.healthInsuranceProvider },
        { label: "Condición física actual", value: s.fitnessLevel },
        { label: "Contraindicación médica", value: s.hasContraindication },
        { label: "Último entrenamiento supervisado", value: s.lastSupervisedTraining },
        { label: "Último examen médico", value: s.lastMedicalExam },
        { label: "Dolor habitual", value: s.hasPain },
        { label: "Enfermedad que condicione rendimiento", value: s.hasCondition },
        { label: "Lesión último año", value: s.hadInjuryLastYear },
        { label: "Diabetes", value: s.diabetes },
        { label: "Presión arterial", value: s.bloodPressure },
        { label: "Fumás", value: s.smokes },
        { label: "Problemas cardíacos", value: s.heartProblems },
        { label: "Tratamiento oncológico", value: s.oncologicTreatment },
        { label: "Problema ortopédico", value: s.orthoProblem },
        { label: "Embarazada", value: s.pregnant },
        { label: "Último análisis de sangre", value: s.lastBloodTest },
        { label: "Información relevante", value: s.relevantInfo },
      ])}

      ${renderSectionPanel("Step 2 · Rehabilitación", [
        { label: "Necesita rehabilitación", value: s.needsRehab },
        { label: "Diagnóstico y orden médica", value: s.rehab_hasDiagnosisOrder },
        { label: "Síntomas", value: s.rehab_symptoms },
        { label: "Fecha lesión/aparición síntomas", value: s.rehab_symptomDate },
        { label: "Consulta médica", value: s.rehab_medicalConsult },
        { label: "Estudios de diagnóstico", value: s.rehab_diagnosticStudy },
        { label: "Cómo sucedió", value: s.rehab_howHappened },
        { label: "Malestar diario", value: s.rehab_dailyDiscomfort },
        { label: "Imposibilidad para desplazarte", value: s.rehab_mobilityIssue },
        { label: "Toma medicación", value: s.rehab_takesMedication },
      ])}

      ${renderSectionPanel("Step 2 · Actualidad deportiva", [
        { label: "Deporte competitivo", value: s.practicesCompetitiveSport },
        { label: "Nivel", value: s.competitionLevel },
        { label: "Deporte", value: s.sportName },
        { label: "Puesto", value: s.sportPosition },
      ])}

      ${renderSectionPanel("Step 2 · Nuevo plan", [
        { label: "Objetivo inmediato", value: s.immediateGoal },
        { label: "Entrenaría solo/a", value: s.trainAlone },
        { label: "Rango horario ideal", value: s.idealSchedule },
        { label: "Días preferenciales", value: s.preferredDays },
        { label: "Sesiones semanales", value: s.weeklySessions },
        { label: "Modalidad", value: s.modality },
        { label: "Aceptó términos", value: s.acceptsConsent },
      ])}
    `,
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   USER email
========================================================= */

export async function sendUserAdmissionReceivedEmail(
  admissionDoc = {},
  pseudoUser = null
) {
  const email = cleanStr(
    pseudoUser?.email || admissionDoc?.step1?.email,
    ""
  ).trim();
  if (!email) return;

  const s = admissionSummary(admissionDoc, pseudoUser);

  console.log("[MAIL][ADM] user received ->", {
    to: email,
    publicId: s.publicId,
    admissionId: s.admissionId,
    fullName: s.fullName,
  });

  const helloName =
    cleanStr(pseudoUser?.name, "") ||
    cleanStr(s.fullName, "") ||
    "NOMBRE";

  const subject = `✅ Recibimos tu formulario - ${BRAND_NAME}`;

  const text = [
    `Hola ${helloName},`,
    "",
    "Gracias por completar el formulario.",
    "Tu solicitud fue enviada con éxito y se encuentra pendiente de admisión.",
    "",
    "¿Qué sigue ahora?",
    "Revisaremos tu información.",
    "Si falta algún dato, te lo solicitaremos.",
    "Si está todo OK, recibirás el mail de alta.",
    "",
    "Gracias por confiar en DUO.",
  ].join("\n");

  const html = buildAdmissionEmail({
    title: "Tu formulario fue\nenviado con éxito",
    preheader: "Tu formulario fue enviado con éxito",
    icon: "✓",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(helloName)}</b>,<br/>Gracias por completar el formulario.<br/><b>Tu solicitud fue enviada con éxito y se encuentra pendiente de admisión.</b><br/>Nuestro equipo la revisará y te avisaremos por este medio cuando tu acceso haya sido aprobado.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 330,
          marginBottom: 16,
        }
      )}

      ${renderAdminDetailPanel([
        { label: "Código", value: `#${s.publicId}` },
        { label: "Estado", value: "Pendiente de admisión" },
      ])}

      ${renderExactBodyText("¿Qué sigue ahora?", {
        fontSize: 14,
        lineHeight: 18,
        weight: 900,
        maxWidth: 320,
        marginTop: 4,
        marginBottom: 10,
      })}

      ${renderAdminDetailPanel([
        { label: "Paso 1", value: "Revisaremos tu información" },
        {
          label: "Paso 2",
          value: "Si falta algún dato, te lo solicitaremos",
        },
        {
          label: "Paso 3",
          value: "Si está todo OK, recibirás el mail de alta",
        },
      ])}

      ${renderExactBodyText("Gracias por confiar en DUO.", {
        fontSize: 13,
        lineHeight: 18,
        weight: 700,
        maxWidth: 320,
        marginTop: 8,
        marginBottom: 0,
      })}
    `,
  });

  await sendMail(email, subject, text, html);
}

/* =========================================================
   USER email: Alta aprobada
========================================================= */

export async function sendUserApprovedEmail({
  to,
  user = null,
  password = "",
  loginUrl = "",
} = {}) {
  const email = cleanStr(to || user?.email, "").trim();
  if (!email) return;

  const fullName =
    cleanStr(`${user?.name || ""} ${user?.lastName || ""}`.trim(), "") ||
    cleanStr(user?.fullName, "") ||
    "Hola";

  const url = cleanStr(loginUrl || `${BRAND_URL}/login`, `${BRAND_URL}/login`);
  const hasPass = !!String(password || "").trim();

  console.log("[MAIL][APPROVAL] send approved ->", {
    to: email,
    fullName,
    hasPass,
  });

  const subject = `✅ Alta aprobada - ${BRAND_NAME}`;

  const textLines = [
    `Hola ${fullName},`,
    "",
    "Tu alta fue aprobada. Ya podés ingresar a la plataforma.",
    "",
    `Ingresar: ${url}`,
    "",
    `Email: ${email}`,
  ];

  if (hasPass) {
    textLines.push(
      "",
      `Contraseña temporal: ${String(password).trim()}`,
      "En tu primer ingreso te vamos a pedir que la cambies."
    );
  }

  textLines.push("", `Si no fuiste vos, escribinos a ${ADMIN_EMAIL}.`);

  const text = textLines.join("\n");

  const detailRows = [{ label: "Email", value: email }];

  if (hasPass) {
    detailRows.push({
      label: "Contraseña temporal",
      value: String(password).trim(),
    });
  }

  const html = buildAdmissionEmail({
    title: "Alta aprobada",
    preheader: "Tu alta fue aprobada",
    icon: "✓",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(fullName)}</b>,<br/>Tu alta fue <b>aprobada</b>. Ya podés ingresar a la plataforma.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 330,
          marginBottom: 16,
        }
      )}

      ${renderAdminDetailPanel(detailRows)}

      ${renderPrimaryButton("Ingresar", url)}

      ${
        hasPass
          ? renderExactBodyText(
              "En tu primer ingreso te vamos a pedir que cambies la contraseña temporal.",
              {
                fontSize: 12,
                lineHeight: 17,
                weight: 600,
                maxWidth: 320,
                marginTop: 10,
                marginBottom: 0,
              }
            )
          : ""
      }
    `,
  });

  await sendMail(email, subject, text, html);
}