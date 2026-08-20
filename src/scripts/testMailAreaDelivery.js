import "dotenv/config";

const { sendMail } = await import("../src/mail/core.js");
const {
  adminRecipientsForService,
  TRAINING_ZONE_EMAIL,
  PERFORMANCE_ZONE_EMAIL,
} = await import("../src/mail/recipients.js");
const { buildEmailLayout } = await import("../src/mail/layout.js");
const { renderUnifiedMailFooter } = await import("../src/mail/ui.js");

function safeList(value) {
  return (Array.isArray(value) ? value : [value])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

function testBody({ area, service, serviceKey, recipients }) {
  const toText = recipients.join(", ");

  return buildEmailLayout({
    title: `DUO · Test ${area}`,
    preheader: `Prueba controlada de routing de mails ${area}`,
    footerNote: "",
    bodyHtml: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:410px;border-collapse:separate;border-spacing:0;background:#fbfbfb;border-radius:28px;overflow:hidden;">
              <tr>
                <td style="background:#0a0a0a;padding:22px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#fff;">
                  <div style="font-size:29px;line-height:34px;font-weight:750;letter-spacing:-.8px;">Test de routing.</div>
                  <div style="margin-top:7px;font-size:14px;line-height:20px;color:#d7d7d7;font-weight:500;">${area}</div>
                </td>
              </tr>
              <tr>
                <td style="padding:24px 22px 28px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#111;">
                  <div style="font-size:16px;line-height:24px;font-weight:500;">
                    Este es un <strong style="font-weight:700;">mail de prueba controlado</strong> para comprobar la separación de notificaciones internas de DUO.
                  </div>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-collapse:collapse;">
                    <tr>
                      <td style="padding:9px 0;border-bottom:1px solid #e3e3df;font-size:13px;color:#666;font-weight:500;">Área</td>
                      <td align="right" style="padding:9px 0;border-bottom:1px solid #e3e3df;font-size:13px;color:#111;font-weight:700;">${area}</td>
                    </tr>
                    <tr>
                      <td style="padding:9px 0;border-bottom:1px solid #e3e3df;font-size:13px;color:#666;font-weight:500;">Servicio</td>
                      <td align="right" style="padding:9px 0;border-bottom:1px solid #e3e3df;font-size:13px;color:#111;font-weight:700;">${service}</td>
                    </tr>
                    <tr>
                      <td style="padding:9px 0;border-bottom:1px solid #e3e3df;font-size:13px;color:#666;font-weight:500;">Service key</td>
                      <td align="right" style="padding:9px 0;border-bottom:1px solid #e3e3df;font-size:13px;color:#111;font-weight:700;">${serviceKey}</td>
                    </tr>
                    <tr>
                      <td style="padding:9px 0;font-size:13px;color:#666;font-weight:500;">Destino resuelto</td>
                      <td align="right" style="padding:9px 0;font-size:13px;color:#111;font-weight:700;">${toText}</td>
                    </tr>
                  </table>
                  <div style="margin-top:18px;padding:13px 14px;background:#f1f1ee;border-radius:14px;font-size:12px;line-height:18px;color:#555;font-weight:500;">
                    Esta prueba no crea turnos, no crea órdenes, no modifica sesiones y no escribe en MongoDB.
                  </div>
                </td>
              </tr>
              ${renderUnifiedMailFooter()}
            </table>
          </td>
        </tr>
      </table>
    `,
  });
}

const tests = [
  {
    area: "DUO TRAINING",
    service: "Entrenamiento Personal",
    serviceKey: "EP",
    expected: TRAINING_ZONE_EMAIL,
  },
  {
    area: "DUO PERFORMANCE",
    service: "Synergy",
    serviceKey: "SYN",
    expected: PERFORMANCE_ZONE_EMAIL,
  },
];

console.log("\n============================================");
console.log("TEST REAL DE ROUTING DE MAILS DUO");
console.log("============================================");
console.log(`Training configurado: ${TRAINING_ZONE_EMAIL}`);
console.log(`Performance configurado: ${PERFORMANCE_ZONE_EMAIL}`);
console.log("MongoDB: no se utiliza\n");

let ok = 0;
let errors = 0;

for (const test of tests) {
  const recipients = safeList(adminRecipientsForService(test.serviceKey));
  const expected = String(test.expected || "").trim();

  process.stdout.write(`➡ ${test.area} · ${test.serviceKey} -> ${recipients.join(", ") || "SIN DESTINO"} ... `);

  if (recipients.length !== 1 || recipients[0] !== expected) {
    console.log("❌");
    console.log(`   Routing inesperado. Esperado: ${expected}`);
    errors += 1;
    continue;
  }

  try {
    const subject = `[TEST DUO] ${test.area} · ${test.service}`;
    const text = [
      "TEST CONTROLADO DE ROUTING DUO",
      "",
      `Área: ${test.area}`,
      `Servicio: ${test.service}`,
      `Service key: ${test.serviceKey}`,
      `Destino resuelto: ${recipients.join(", ")}`,
      "",
      "No se modificó MongoDB ni se generaron reservas, órdenes o sesiones.",
    ].join("\n");

    const html = testBody({ ...test, recipients });
    await sendMail(recipients, subject, text, html);
    console.log("✅");
    ok += 1;
  } catch (error) {
    console.log("❌");
    console.log(`   ${error?.message || error}`);
    errors += 1;
  }
}

console.log("\n============================================");
console.log("TEST DE ROUTING FINALIZADO");
console.log(`Mails enviados OK: ${ok}`);
console.log(`Errores: ${errors}`);
console.log("MongoDB: no se modificó");
console.log("============================================\n");

if (errors > 0) process.exitCode = 1;
