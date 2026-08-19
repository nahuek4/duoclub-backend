// scripts/previewMailsDuo.js
// Envía previews REALES de los templates de mail de DUO sin tocar MongoDB.
// Uso:
//   node scripts/previewMailsDuo.js --group=subscription --to=nahuek.75@gmail.com
//   node scripts/previewMailsDuo.js --group=appointments --to=nahuek.75@gmail.com
//   node scripts/previewMailsDuo.js --group=all --to=nahuek.75@gmail.com

import dotenv from "dotenv";
dotenv.config();

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((x) => String(x).startsWith(prefix));
  return found ? String(found).slice(prefix.length).trim() : fallback;
}

const TO = arg("to", "nahuek.75@gmail.com");
const GROUP = arg("group", "").toLowerCase();
const DELAY_MS = Math.max(0, Number(arg("delay", "450")) || 0);

const VALID_GROUPS = new Set([
  "auth",
  "admission",
  "appointments",
  "orders",
  "credits",
  "medical",
  "notifications",
  "subscription",
  "all",
]);

if (!TO || !TO.includes("@")) {
  console.error("❌ Falta un email válido en --to=");
  process.exit(1);
}

if (!VALID_GROUPS.has(GROUP)) {
  console.log("Uso:");
  console.log(
    "  node scripts/previewMailsDuo.js --group=<grupo> --to=nahuek.75@gmail.com"
  );
  console.log("");
  console.log(
    "Grupos: auth, admission, appointments, orders, credits, medical, notifications, subscription, all"
  );
  process.exit(1);
}

// IMPORTANTE:
// Sobrescribimos TODOS los destinos administrativos ANTES de importar mail.js.
// Así ningún preview se envía a los correos reales de DUO.
process.env.ADMIN_EMAIL = TO;
process.env.TRAINING_ZONE_EMAIL = TO;
process.env.PERFORMANCE_ZONE_EMAIL = TO;

const mail = await import("../src/mail.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sentCalls = 0;
let failedCalls = 0;

async function run(label, fn) {
  process.stdout.write(`➡ ${label} ... `);
  try {
    await fn();
    sentCalls += 1;
    console.log("✅");
  } catch (error) {
    failedCalls += 1;
    console.log("❌");
    console.error(`   ${error?.message || error}`);
  }
  if (DELAY_MS) await sleep(DELAY_MS);
}

function wants(group) {
  return GROUP === "all" || GROUP === group;
}

const user = {
  _id: "68a5f2d6aa00000000000001",
  id: "68a5f2d6aa00000000000001",
  name: "Nahuel",
  lastName: "Cañete",
  fullName: "Nahuel Cañete",
  email: TO,
  phone: "+54 9 249 400 0000",
  emailVerified: true,
};

const epAppointment = {
  _id: "68a5f2d6aa00000000000101",
  date: "2026-09-08",
  time: "08:00",
  serviceKey: "EP",
  service: "Entrenamiento Personal",
  serviceName: "Entrenamiento Personal",
  notes: "Preview de mail — no es un turno real.",
  status: "reserved",
};

const synAppointment = {
  _id: "68a5f2d6aa00000000000102",
  date: "2026-09-09",
  time: "17:00",
  serviceKey: "SYN",
  service: "Synergy",
  serviceName: "Synergy",
  notes: "Preview de mail — no es un turno real.",
  status: "reserved",
};

const orderPending = {
  _id: "68a5f2d6aa00000000000201",
  publicId: "TEST-EP-001",
  createdAt: new Date("2026-09-01T10:00:00-03:00"),
  status: "pending",
  payMethod: "CASH",
  totalFinal: 70000,
  total: 70000,
  customerEmail: TO,
  items: [
    {
      kind: "CREDITS",
      serviceKey: "EP",
      credits: 8,
      qty: 1,
      price: 70000,
      label: "Plan Entrenamiento Personal · 8 sesiones",
    },
  ],
};

const orderPaid = {
  ...orderPending,
  _id: "68a5f2d6aa00000000000202",
  publicId: "TEST-SYN-002",
  status: "paid",
  payMethod: "MP",
  totalFinal: 63000,
  total: 63000,
  items: [
    {
      kind: "CREDITS",
      serviceKey: "SYN",
      credits: 4,
      qty: 1,
      price: 63000,
      label: "Plan Synergy · 4 sesiones",
    },
  ],
};

const admission = {
  _id: "68a5f2d6aa00000000000301",
  publicId: "ADM-TEST-001",
  createdAt: new Date("2026-08-19T13:30:00-03:00"),
  step1: {
    fullName: "Nahuel Cañete",
    name: "Nahuel",
    lastName: "Cañete",
    email: TO,
    phone: "+54 9 249 400 0000",
    city: "Tandil",
    birthDay: 15,
    birthMonth: 5,
    birthYear: 1995,
    height: "178 cm",
    weight: "78 kg",
    healthInsuranceProvider: "OSDE",
    fitnessLevel: "Intermedio",
    hasContraindication: "NO",
    lastSupervisedTraining: "Hace 1 mes",
    lastMedicalExam: "Julio 2026",
    hasPain: "NO",
    hasCondition: "NO",
    hadInjuryLastYear: "NO",
    diabetes: "NO",
    bloodPressure: "Normal",
    smokes: "NO",
    heartProblems: "NO",
    oncologicTreatment: "NO",
    orthoProblem: "NO",
    pregnant: "NO",
    lastBloodTest: "Junio 2026",
    relevantInfo: "Datos ficticios para revisar el diseño del mail.",
  },
  step2: {
    needsRehab: "NO",
    rehab_hasDiagnosisOrder: "NO",
    rehab_symptoms: "-",
    rehab_symptomDate: "-",
    rehab_medicalConsult: "-",
    rehab_diagnosticStudy: "-",
    rehab_howHappened: "-",
    rehab_dailyDiscomfort: "NO",
    rehab_mobilityIssue: "NO",
    rehab_takesMedication: "NO",
    practicesCompetitiveSport: "SI",
    competitionLevel: "Amateur",
    sportName: "Running",
    sportPosition: "-",
    immediateGoal: "Mejorar rendimiento",
    trainAlone: "SI",
    idealSchedule: "Mañana",
    preferredDays: "Lunes, miércoles y viernes",
    weeklySessions: "3",
    modality: "DUO Training",
    acceptsConsent: "SI",
  },
};

if (wants("auth")) {
  await run("AUTH · verificación de email", () =>
    mail.sendVerifyEmail(user, "https://duoclub.ar/agenda/verificar-email?token=TEST-NO-CLICK")
  );

  await run("AUTH · registro recibido", () =>
    mail.sendUserRegistrationReceivedEmail(
      user,
      "https://duoclub.ar/agenda/verificar-email?token=TEST-NO-CLICK"
    )
  );

  await run("AUTH · nuevo registro (admin)", () =>
    mail.sendAdminNewRegistrationEmail({
      user,
      approveUrl: "https://duoclub.ar/agenda/#TEST-APROBAR-NO-CLICK",
      rejectUrl: "https://duoclub.ar/agenda/#TEST-RECHAZAR-NO-CLICK",
    })
  );

  await run("AUTH · cuenta aprobada", () =>
    mail.sendUserApprovalResultEmail(user, "approved")
  );

  await run("AUTH · cuenta rechazada", () =>
    mail.sendUserApprovalResultEmail(user, "rejected")
  );
}

if (wants("admission")) {
  await run("ADMISIÓN · formulario recibido (usuario)", () =>
    mail.sendUserAdmissionReceivedEmail(admission, user)
  );

  await run("ADMISIÓN · formulario completo (admin)", () =>
    mail.sendAdminAdmissionCompletedEmail(admission, user)
  );

  await run("ADMISIÓN · alta aprobada con contraseña temporal", () =>
    mail.sendUserApprovedEmail({
      to: TO,
      user,
      password: "TEST-1234",
      loginUrl: "https://duoclub.ar/agenda/login",
    })
  );
}

if (wants("appointments")) {
  // booked/cancelled mandan mail al usuario + copia administrativa internamente.
  await run("TURNOS · reserva EP (usuario + admin)", () =>
    mail.sendAppointmentBookedEmail(user, epAppointment, "Entrenamiento Personal")
  );

  await run("TURNOS · cancelación SYN (usuario + admin)", () =>
    mail.sendAppointmentCancelledEmail(user, synAppointment, "Synergy", {
      refund: true,
      refundCutoffHours: 24,
    })
  );

  await run("TURNOS · recordatorio 24 h", () =>
    mail.sendAppointmentReminderEmail(user, epAppointment, "Entrenamiento Personal")
  );

  await run("TURNOS · reserva múltiple", () =>
    mail.sendAppointmentBookedBatchEmail(user, [epAppointment, synAppointment])
  );

  await run("TURNOS · lista de espera", () =>
    mail.sendWaitlistSlotAvailableEmail(user, synAppointment, {
      token: "TEST-WAITLIST-NO-CLICK",
      totalNotified: 3,
    })
  );
}

if (wants("orders")) {
  await run("PAGOS · pedido pendiente (usuario)", () =>
    mail.sendOrderPendingEmail(orderPending, user, {
      paymentUrl: "https://duoclub.ar/agenda/mi-plan",
    })
  );

  await run("PAGOS · pedido pendiente (admin Training)", () =>
    mail.sendAdminOrderPendingEmail(orderPending, user)
  );

  await run("PAGOS · pedido pagado (usuario)", () =>
    mail.sendOrderPaidEmail(orderPaid, user)
  );

  await run("PAGOS · pedido pagado (admin Performance)", () =>
    mail.sendAdminOrderPaidEmail(orderPaid, user)
  );

  await run("PAGOS · pedido cancelado (usuario)", () =>
    mail.sendOrderCancelledEmail({ ...orderPending, status: "cancelled" }, user)
  );

  await run("PAGOS · pedido cancelado (admin)", () =>
    mail.sendAdminOrderCancelledEmail(
      { ...orderPending, status: "cancelled" },
      user
    )
  );
}

if (wants("credits")) {
  const changesEP = [{ serviceKey: "EP", delta: 2 }];
  const changesPerformance = [
    { serviceKey: "RF", delta: 1 },
    { serviceKey: "SYN", delta: 1 },
  ];

  await run("SESIONES · actualización manual (usuario)", () =>
    mail.sendCreditsChangedEmail(user, changesEP, {
      actorName: "Administrador DUO",
      reason: "Preview de contenido del mail",
    })
  );

  await run("SESIONES · actualización manual (admin Training)", () =>
    mail.sendAdminCreditsChangedEmail(user, changesEP, {
      actorName: "Administrador DUO",
      reason: "Preview de contenido del mail",
    })
  );

  await run("SESIONES · actualización manual (admin Performance)", () =>
    mail.sendAdminCreditsChangedEmail(user, changesPerformance, {
      actorName: "Administrador DUO",
      reason: "Preview de contenido del mail",
    })
  );
}

if (wants("medical")) {
  const medicalUser = {
    ...user,
    medicalClearance: {
      dueAt: new Date("2026-09-18T23:59:59-03:00"),
    },
  };

  await run("APTO · recordatorio día 10", () =>
    mail.sendMedicalClearanceReminderEmail(medicalUser, {
      day: 10,
      dueAt: medicalUser.medicalClearance.dueAt,
    })
  );

  await run("APTO · recordatorio día 20", () =>
    mail.sendMedicalClearanceReminderEmail(medicalUser, {
      day: 20,
      dueAt: medicalUser.medicalClearance.dueAt,
    })
  );

  await run("APTO · último aviso día 30", () =>
    mail.sendMedicalClearanceReminderEmail(medicalUser, {
      day: 30,
      dueAt: medicalUser.medicalClearance.dueAt,
    })
  );

  await run("APTO · recibido", () =>
    mail.sendMedicalClearanceReceivedEmail(medicalUser)
  );

  await run("APTO · aprobado", () =>
    mail.sendMedicalClearanceApprovedEmail(medicalUser)
  );

  await run("APTO · observado", () =>
    mail.sendMedicalClearanceRejectedEmail(medicalUser, {
      note: "El archivo de prueba no permite validar la fecha del certificado.",
    })
  );

  await run("APTO · reserva suspendida", () =>
    mail.sendMedicalClearanceSuspendedEmail(medicalUser)
  );
}

if (wants("notifications")) {
  await run("NOTIFICACIONES · sesiones por vencer", () =>
    mail.sendCreditsExpiryReminderEmail(
      user,
      { EP: 3, RA: 0, RF: 1, SYN: 0 },
      {
        monthLabel: "agosto de 2026",
        lastUsableAt: new Date("2026-08-31T23:59:59-03:00"),
        expiryAt: new Date("2026-09-01T00:00:00-03:00"),
      }
    )
  );

  await run("NOTIFICACIONES · cumpleaños (usuario)", () =>
    mail.sendBirthdayEmail(user)
  );

  await run("NOTIFICACIONES · cumpleaños (admin)", () =>
    mail.sendAdminBirthdayEmail(user)
  );
}

if (wants("subscription")) {
  await run("PLAN · renovación mensual EP", () =>
    mail.sendSubscriptionRenewalEmail({
      user,
      serviceKey: "EP",
      serviceName: "Entrenamiento Personal",
      periodKey: "2026-09",
      monthlySessions: 8,
      amount: 70000,
      payMethod: "CASH",
      dueAt: new Date("2026-09-10T23:59:59-03:00"),
      nextRenewalAt: new Date("2026-10-01T00:00:00-03:00"),
      billingStatus: "pending",
      extraSessionsNeeded: 1,
    })
  );

  await run("PLAN · renovación mensual Synergy", () =>
    mail.sendSubscriptionRenewalEmail({
      user,
      serviceKey: "SYN",
      serviceName: "Synergy",
      periodKey: "2026-09",
      monthlySessions: 4,
      amount: 60000,
      payMethod: "MP",
      dueAt: new Date("2026-09-10T23:59:59-03:00"),
      nextRenewalAt: new Date("2026-10-01T00:00:00-03:00"),
      billingStatus: "paid",
      extraSessionsNeeded: 0,
    })
  );
}

console.log("");
console.log("============================================");
console.log("PREVIEW DE MAILS DUO FINALIZADO");
console.log(`Destino forzado: ${TO}`);
console.log(`Grupo: ${GROUP}`);
console.log(`Llamadas OK: ${sentCalls}`);
console.log(`Llamadas con error: ${failedCalls}`);
console.log("MongoDB: no se modificó");
console.log("============================================");

if (failedCalls > 0) process.exitCode = 1;
