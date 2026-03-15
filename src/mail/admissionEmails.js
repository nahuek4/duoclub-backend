import { ADMIN_EMAIL, BRAND_NAME, sendMail, BRAND_URL } from "./core.js";
import { escapeHtml, kvRow, kvRowRaw } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

const EMAIL_FONT =
  "'Helvetica Now Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";

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

function qaRow(question, answer) {
  return kvRow(question, cleanStr(answer));
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

  const bodyHtml = `
    <div style="font-family:${EMAIL_FONT}; display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-family:${EMAIL_FONT}; font-size:18px; font-weight:800;">Formulario completado</div>
      <div style="font-family:${EMAIL_FONT}; margin-left:auto; background:#e9f7ef; color:#0b6b2a; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        COMPLETO
      </div>
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${qaRow("Código", `#${s.publicId}`)}
        ${qaRow("AdmissionId", s.admissionId)}
        ${qaRow("Creado", `${s.createdDate} ${s.createdTime}`)}
        ${qaRow("Nombre y apellido", s.fullName)}
        ${qaRow("Mail", s.email)}
        ${qaRow("Teléfono de contacto", s.phone)}
        ${qaRow("Ciudad", s.city)}
      </table>
    </div>

    <div style="font-family:${EMAIL_FONT}; margin-top:14px; font-size:13px; font-weight:900;">STEP 1 · Datos personales</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${qaRow("Fecha de nacimiento", s.birth)}
        ${qaRow("Altura", s.height)}
        ${qaRow("Peso aproximado", s.weight)}
      </table>
    </div>

    <div style="font-family:${EMAIL_FONT}; margin-top:14px; font-size:13px; font-weight:900;">STEP 1 · Tu actualidad física</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${qaRow("Cómo considerás tu condición física actual", s.fitnessLevel)}
        ${qaRow("Tenés alguna contraindicación médica?", s.hasContraindication)}
        ${qaRow("Cuándo fue la última vez que entrenaste supervisado/a?", s.lastSupervisedTraining)}
        ${qaRow("Cuándo realizaste el último examen médico?", s.lastMedicalExam)}
        ${qaRow("Sufrís algún dolor habitualmente?", s.hasPain)}
        ${qaRow("Tenés diagnosticada alguna enfermedad que condicione tu rendimiento?", s.hasCondition)}
        ${qaRow("Cursaste alguna lesión el último año?", s.hadInjuryLastYear)}
      </table>
    </div>

    <div style="font-family:${EMAIL_FONT}; margin-top:14px; font-size:13px; font-weight:900;">STEP 1 · Acerca de tu salud general</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${qaRow("Diabetes", s.diabetes)}
        ${qaRow("Presión arterial", s.bloodPressure)}
        ${qaRow("Fumás?", s.smokes)}
        ${qaRow("Problemas cardíacos", s.heartProblems)}
        ${qaRow("Tratamiento oncológico", s.oncologicTreatment)}
        ${qaRow("Problema ortopédico", s.orthoProblem)}
        ${qaRow("Actualmente embarazada?", s.pregnant)}
        ${qaRow("Cuando realizaste el último análisis de sangre", s.lastBloodTest)}
        ${qaRow("Información relevante", s.relevantInfo)}
      </table>
    </div>

    <div style="font-family:${EMAIL_FONT}; margin-top:14px; font-size:13px; font-weight:900;">STEP 2 · Rehabilitación</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${qaRow("Necesita rehabilitación", s.needsRehab)}
        ${qaRow("Tenés diagnóstico y órden médica para iniciar tu rehabilitación?", s.rehab_hasDiagnosisOrder)}
        ${qaRow("Cuáles son tus síntomas", s.rehab_symptoms)}
        ${qaRow("Recordás fecha de lesión o aparición de síntomas?", s.rehab_symptomDate)}
        ${qaRow("Realizaste consulta médica?", s.rehab_medicalConsult)}
        ${qaRow("Realizaste estudios de diagnóstico?", s.rehab_diagnosticStudy)}
        ${qaRow("Cómo sucedió?", s.rehab_howHappened)}
        ${qaRow("Cómo calificarías tu malestar diario?", s.rehab_dailyDiscomfort)}
        ${qaRow("Tenés imposibilidad para desplazarte?", s.rehab_mobilityIssue)}
        ${qaRow("Tomás medicación?", s.rehab_takesMedication)}
      </table>
    </div>

    <div style="font-family:${EMAIL_FONT}; margin-top:14px; font-size:13px; font-weight:900;">STEP 2 · Tu actualidad deportiva</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${qaRow("Practicás un deporte de forma competitiva?", s.practicesCompetitiveSport)}
        ${qaRow("Competís a nivel", s.competitionLevel)}
        ${qaRow("Cuál es tu deporte", s.sportName)}
        ${qaRow("Cuál es tu puesto frecuente", s.sportPosition)}
      </table>
    </div>

    <div style="font-family:${EMAIL_FONT}; margin-top:14px; font-size:13px; font-weight:900;">STEP 2 · Tu nuevo plan</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${qaRow("Cuál es tu objetivo inmediato?", s.immediateGoal)}
        ${qaRow("Entrenarías solo/a?", s.trainAlone)}
        ${qaRow("Cuál es tu rango horario ideal?", s.idealSchedule)}
        ${qaRow("Tenés días preferenciales?", s.preferredDays)}
        ${qaRow("Qué frecuencia querés destinar? (sesiones semanales)", s.weeklySessions)}
        ${qaRow("Qué modalidad te gustaría contratar?", s.modality)}
      </table>
    </div>

    <div style="font-family:${EMAIL_FONT}; margin-top:14px; font-size:13px; font-weight:900;">Consentimiento</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${qaRow("Aceptó términos", s.acceptsConsent)}
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

  const bodyHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
      <tr>
        <td align="center" style="padding:0 0 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:430px; border-collapse:separate;">
            <tr>
              <td
                bgcolor="#ffffff"
                style="
                  background:#ffffff;
                  border-radius:18px;
                  padding:22px 18px 20px;
                  text-align:center;
                  font-family:${EMAIL_FONT};
                  color:#111111;
                "
              >
                <div style="
                  width:58px;
                  height:58px;
                  margin:0 auto 16px;
                  border-radius:999px;
                  background:#000;
                  color:#fff;
                  font-size:38px;
                  line-height:58px;
                  font-weight:900;
                  font-family:${EMAIL_FONT};
                ">✓</div>

                <div style="
                  font-size:20px;
                  line-height:24px;
                  font-weight:900;
                  margin:0 auto 26px;
                  max-width:280px;
                  font-family:${EMAIL_FONT};
                ">
                  Tu formulario fue<br/>enviado con éxito
                </div>

                <div style="
                  font-size:16px;
                  line-height:22px;
                  font-weight:600;
                  max-width:380px;
                  margin:0 auto;
                  font-family:${EMAIL_FONT};
                ">
                  <div style="margin-bottom:12px; font-family:${EMAIL_FONT};">
                    Hola (${escapeHtml(helloName)}),
                  </div>

                  <div style="margin-bottom:14px; font-family:${EMAIL_FONT};">
                    Gracias por completar el formulario.<br/>
                    <span style="font-weight:800; font-family:${EMAIL_FONT};">
                      Tu solicitud fue enviada con éxito y se encuentra pendiente de admisión.
                    </span><br/>
                    Nuestro equipo la revisará y te avisaremos por este medio cuando tu acceso haya sido aprobado.
                  </div>

                  <div style="margin-bottom:10px; font-weight:800; font-family:${EMAIL_FONT};">
                    ▶ ¿Qué sigue ahora?
                  </div>

                  <div style="font-family:${EMAIL_FONT};">
                    Revisaremos tu información<br/>
                    Si falta algún dato, te lo solicitaremos<br/>
                    Si está todo OK, recibirás el mail de alta<br/>
                    Gracias por confiar en DUO.
                  </div>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Formulario recibido`,
    preheader: `Tu formulario fue enviado con éxito`,
    bodyHtml,
    footerNote: "",
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

  const bodyHtml = `
    <div style="font-family:${EMAIL_FONT}; display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-family:${EMAIL_FONT}; font-size:18px; font-weight:800;">Alta aprobada</div>
      <div style="font-family:${EMAIL_FONT}; margin-left:auto; background:#e9f7ef; color:#0b6b2a; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        APROBADA
      </div>
    </div>

    <div style="font-family:${EMAIL_FONT}; color:#333; margin-bottom:12px;">
      Hola <b>${escapeHtml(
        fullName
      )}</b>, tu alta fue <b>aprobada</b>. Ya podés ingresar a la plataforma.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${kvRow("Email", email)}
        ${kvRowRaw(
          "Ingreso",
          `<a href="${escapeHtml(
            url
          )}" style="color:#111; font-weight:800; text-decoration:none; font-family:${EMAIL_FONT};">${escapeHtml(
            url
          )}</a>`
        )}
      </table>
    </div>

    ${
      hasPass
        ? `
      <div style="font-family:${EMAIL_FONT}; margin-top:14px; font-size:13px; font-weight:800;">Tu contraseña temporal</div>
      <div style="margin-top:8px; border:1px solid #eee; border-radius:14px; overflow:hidden;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
          ${kvRowRaw(
            "Password",
            `<span style="font-family:${EMAIL_FONT}; font-size:16px; letter-spacing:0.6px; font-weight:900;">${escapeHtml(
              String(password).trim()
            )}</span>`
          )}
          ${kvRow(
            "Importante",
            "En tu primer ingreso te vamos a pedir que la cambies."
          )}
        </table>
      </div>
    `
        : ""
    }
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Alta aprobada`,
    preheader: `Tu alta fue aprobada · Ya podés ingresar`,
    bodyHtml,
  });

  await sendMail(email, subject, text, html);
}