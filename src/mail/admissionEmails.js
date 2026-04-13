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
} from "./ui.js";

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

  return {
    admissionId,
    publicId,
    createdDate,
    createdTime,
    fullName,
    email,
    phone,
    city,
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
  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title,
    preheader,
    icon,
    innerHtml,
  });

  return buildEmailLayout({
    title: exact.title,
    preheader: exact.preheader,
    bodyHtml: exact.bodyHtml,
    footerNote: "",
  });
}

/* =========================================================
   ADMIN email
========================================================= */

export async function sendAdminAdmissionCompletedEmail(
  admissionDoc = {},
  pseudoUser = null
) {
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
    "Formulario de admisión completado (Step1 + Step2)",
    "",
    `Código: #${s.publicId}`,
    `AdmissionId: ${s.admissionId}`,
    `Creado: ${s.createdDate} ${s.createdTime}`,
    "",
    "=== DATOS DE CONTACTO ===",
    `Nombre: ${s.fullName}`,
    `Email: ${s.email}`,
    `Tel: ${s.phone}`,
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

  const html = buildAdmissionEmail({
    title: "Formulario completo",
    preheader: `Admisión completa #${s.publicId}`,
    icon: "✓",
    innerHtml: `
      ${renderAdminMetaPanel([
        { label: "Código", value: `#${s.publicId}` },
        { label: "AdmissionId", value: s.admissionId },
      ])}

      ${renderAdminDetailPanel([
        { label: "Creado", value: `${s.createdDate} ${s.createdTime}` },
        { label: "Nombre", value: s.fullName },
        { label: "Email", value: s.email },
        { label: "Teléfono", value: s.phone },
        { label: "Ciudad", value: s.city },
      ])}

      ${renderSectionPanel("Step 1 · Datos personales / físico / salud", [
        { label: "Fecha nacimiento", value: s.birth },
        { label: "Altura", value: s.height },
        { label: "Peso", value: s.weight },
        { label: "Condición física actual", value: s.fitnessLevel },
        { label: "Contraindicación médica", value: s.hasContraindication },
        {
          label: "Último entrenamiento supervisado",
          value: s.lastSupervisedTraining,
        },
        { label: "Último examen médico", value: s.lastMedicalExam },
        { label: "Dolor habitual", value: s.hasPain },
        {
          label: "Enfermedad que condicione rendimiento",
          value: s.hasCondition,
        },
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
        {
          label: "Diagnóstico y orden médica",
          value: s.rehab_hasDiagnosisOrder,
        },
        { label: "Síntomas", value: s.rehab_symptoms },
        {
          label: "Fecha lesión/aparición síntomas",
          value: s.rehab_symptomDate,
        },
        { label: "Consulta médica", value: s.rehab_medicalConsult },
        {
          label: "Estudios de diagnóstico",
          value: s.rehab_diagnosticStudy,
        },
        { label: "Cómo sucedió", value: s.rehab_howHappened },
        { label: "Malestar diario", value: s.rehab_dailyDiscomfort },
        {
          label: "Imposibilidad para desplazarte",
          value: s.rehab_mobilityIssue,
        },
        { label: "Toma medicación", value: s.rehab_takesMedication },
      ])}

      ${renderSectionPanel("Step 2 · Actualidad deportiva", [
        {
          label: "Deporte competitivo",
          value: s.practicesCompetitiveSport,
        },
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