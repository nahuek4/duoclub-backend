// frontend/scripts/testDynamicFrontendStep3C1.mjs
//
// Test estático. No llama API y no escribe.
//
// Uso:
//   node scripts/testDynamicFrontendStep3C1.mjs

import fs from "fs";

const files = [
  "src/lib/serviceCatalogClient.js",
  "src/pages/Comprar.jsx",
  "src/pages/MiPlan.jsx",
  "src/pages/Home.jsx",
  "src/pages/Perfil.jsx",
];

const requiredMarkers = {
  "src/lib/serviceCatalogClient.js":
    "STEP3C1_DYNAMIC_SERVICE_CATALOG_HELPER",
  "src/pages/Comprar.jsx":
    "STEP3C1_COMPRAR_DYNAMIC_SERVICES",
  "src/pages/MiPlan.jsx":
    "STEP3C1_MIPLAN_DYNAMIC_SERVICES",
  "src/pages/Home.jsx":
    "STEP3C1_HOME_DYNAMIC_SERVICES",
  "src/pages/Perfil.jsx":
    "STEP3C1_PERFIL_DYNAMIC_SERVICES",
};

const forbidden = {
  "src/pages/Comprar.jsx": [
    '.filter((x) => ["EP", "RF", "RA", "SYN"].includes(x.serviceKey)',
    'function getBuyableServiceKeys() {\n  return ["EP", "RF", "RA", "SYN"];',
  ],
  "src/pages/MiPlan.jsx": [
    '["EP", "RF", "RA", "SYN"].includes(p.serviceKey)',
  ],
  "src/pages/Home.jsx": [
    "if (!ACTIVE_SERVICE_KEYS.has(sk)) return acc;",
    "if (!ACTIVE_SERVICE_KEYS.has(key)) return null;",
    "for (const sk of ACTIVE_SERVICE_KEYS)",
  ],
  "src/pages/Perfil.jsx": [
    "if (!ACTIVE_SERVICE_KEYS.has(sk)) return acc;",
  ],
};

const details = [];

for (const file of files) {
  if (!fs.existsSync(file)) {
    throw new Error(`Falta ${file}`);
  }

  const text = fs.readFileSync(file, "utf8");
  const marker = requiredMarkers[file];

  if (!text.includes(marker)) {
    throw new Error(`${file}: falta marker ${marker}`);
  }

  for (const bad of forbidden[file] || []) {
    if (text.includes(bad)) {
      throw new Error(
        `${file}: todavía contiene hardcode bloqueante: ${bad}`
      );
    }
  }

  details.push({
    file,
    marker: true,
    bytes: Buffer.byteLength(text, "utf8"),
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      writesToDatabase: false,
      networkRequests: false,
      filesChecked: details,
      next:
        "Ejecutar npm run build antes de desplegar. Reservar/Admin no fueron modificados en 3C1.",
    },
    null,
    2
  )
);
