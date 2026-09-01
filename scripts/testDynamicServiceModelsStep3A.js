// backend/scripts/testDynamicServiceModelsStep3A.js
//
// Ejecutar DESPUÉS del apply:
//   node scripts/testDynamicServiceModelsStep3A.js
//
// No crea documentos en Mongo.
// Primero valida TEST_SVC en memoria en todos los modelos modificados.
// Si existe MONGO_URI, además hace una auditoría READ-ONLY de serviceKey existentes.

import "dotenv/config";
import mongoose from "mongoose";

import Appointment from "../src/models/Appointment.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import User from "../src/models/User.js";
import WaitlistEntry from "../src/models/WaitlistEntry.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import CapacityRule from "../src/models/CapacityRule.js";
import ScheduleBlock from "../src/models/ScheduleBlock.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import SubscriptionExtraSessionNotice from "../src/models/SubscriptionExtraSessionNotice.js";
import SubscriptionLifecycleNotice from "../src/models/SubscriptionLifecycleNotice.js";
import ServiceDefinition from "../src/models/ServiceDefinition.js";

const TEST_KEY = "TEST_SVC";
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;

function oid() {
  return new mongoose.Types.ObjectId();
}

async function validateDoc(name, doc, assertions = []) {
  await doc.validate();

  const failed = assertions
    .map((fn) => fn(doc))
    .filter(Boolean);

  if (failed.length) {
    throw new Error(`${name}: ${failed.join(" | ")}`);
  }

  return { name, ok: true };
}

async function runInMemoryTests() {
  const userId = oid();
  const actorId = oid();
  const subscriptionId = oid();

  const tests = [];

  tests.push(
    await validateDoc(
      "Appointment",
      new Appointment({
        user: userId,
        date: "2099-01-05",
        time: "10:00",
        serviceKey: TEST_KEY,
        service: TEST_KEY,
      }),
      [
        (doc) => doc.serviceKey !== TEST_KEY ? `serviceKey=${doc.serviceKey}` : "",
        (doc) => doc.service !== TEST_KEY ? `service=${doc.service}` : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "FixedSchedule",
      new FixedSchedule({
        user: userId,
        createdBy: actorId,
        serviceKey: TEST_KEY,
        service: TEST_KEY,
        items: [{ weekday: 7, time: "10:00" }],
        months: 1,
        startDate: "2099-01-01",
        endDate: "2099-01-31",
      }),
      [
        (doc) => doc.serviceKey !== TEST_KEY ? `serviceKey=${doc.serviceKey}` : "",
        (doc) => Number(doc.items?.[0]?.weekday) !== 7 ? "domingo no aceptado" : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "User.creditLots/history",
      new User({
        name: "Test",
        lastName: "Dynamic Service",
        role: "guest",
        creditLots: [
          {
            serviceKey: TEST_KEY,
            serviceName: TEST_KEY,
            amount: 2,
            remaining: 2,
          },
        ],
        history: [
          {
            action: "test",
            serviceKey: TEST_KEY,
            serviceName: TEST_KEY,
          },
        ],
      }),
      [
        (doc) => doc.creditLots?.[0]?.serviceKey !== TEST_KEY ? "creditLots no conserva TEST_SVC" : "",
        (doc) => doc.history?.[0]?.serviceKey !== TEST_KEY ? "history no conserva TEST_SVC" : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "WaitlistEntry",
      new WaitlistEntry({
        user: userId,
        date: "2099-01-05",
        time: "10:00",
        serviceKey: TEST_KEY,
        service: TEST_KEY,
      }),
      [
        (doc) => doc.serviceKey !== TEST_KEY ? `serviceKey=${doc.serviceKey}` : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "ServiceSubscription",
      new ServiceSubscription({
        user: userId,
        serviceKey: TEST_KEY,
        serviceName: "Servicio prueba",
        monthlySessions: 4,
        price: 100,
        regularPrice: 100,
        payMethod: "CASH",
        status: "active",
      }),
      [
        (doc) => doc.serviceKey !== TEST_KEY ? `serviceKey=${doc.serviceKey}` : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "CapacityRule",
      new CapacityRule({
        targetType: "service",
        zone: "TRAINING",
        serviceKey: TEST_KEY,
        scope: "default",
        limit: 3,
      }),
      [
        (doc) => doc.serviceKey !== TEST_KEY ? `serviceKey=${doc.serviceKey}` : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "ScheduleBlock",
      new ScheduleBlock({
        title: "Test",
        serviceKeys: [TEST_KEY],
        allServices: false,
        dateFrom: "2099-01-01",
        dateTo: "2099-01-31",
        allDay: true,
      }),
      [
        (doc) => !doc.serviceKeys?.includes(TEST_KEY) ? "serviceKeys no conserva TEST_SVC" : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "SubscriptionBillingCycle",
      new SubscriptionBillingCycle({
        subscription: subscriptionId,
        user: userId,
        serviceKey: TEST_KEY,
        periodKey: "2099-01",
        periodStart: new Date("2099-01-01T03:00:00Z"),
        periodEnd: new Date("2099-02-01T02:59:59Z"),
        idempotencyKey: `${subscriptionId}:2099-01`,
        planSnapshot: {
          monthlySessions: 4,
          basePrice: 100,
          regularPrice: 100,
          payMethod: "CASH",
        },
      }),
      [
        (doc) => doc.serviceKey !== TEST_KEY ? `serviceKey=${doc.serviceKey}` : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "SubscriptionExtraSessionNotice",
      new SubscriptionExtraSessionNotice({
        user: userId,
        subscription: subscriptionId,
        serviceKey: TEST_KEY,
        periodKey: "2099-01",
        basePlanSessions: 4,
      }),
      [
        (doc) => doc.serviceKey !== TEST_KEY ? `serviceKey=${doc.serviceKey}` : "",
      ]
    )
  );

  tests.push(
    await validateDoc(
      "SubscriptionLifecycleNotice",
      new SubscriptionLifecycleNotice({
        user: userId,
        subscription: subscriptionId,
        serviceKey: TEST_KEY,
        periodKey: "2099-01",
        type: "renewal_preview",
        title: "Test",
        message: "Test",
      }),
      [
        (doc) => doc.serviceKey !== TEST_KEY ? `serviceKey=${doc.serviceKey}` : "",
      ]
    )
  );

  return tests;
}

function cleanKeys(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((x) => String(x || "").toUpperCase().trim())
      .filter(Boolean)
  )].sort();
}

async function distinctSafe(model, field) {
  try {
    return cleanKeys(await model.distinct(field));
  } catch (error) {
    return [`__ERROR__:${error?.message || error}`];
  }
}

async function runReadOnlyDbAudit() {
  const mongoUri = String(process.env.MONGO_URI || "").trim();
  if (!mongoUri) {
    return {
      skipped: true,
      reason: "MONGO_URI_NOT_SET",
    };
  }

  await mongoose.connect(mongoUri);

  const [
    definitions,
    appointmentKeys,
    fixedKeys,
    creditKeys,
    historyKeys,
    waitlistKeys,
    subscriptionKeys,
    capacityKeys,
    blockKeys,
    cycleKeys,
    extraKeys,
    lifecycleKeys,
  ] = await Promise.all([
    ServiceDefinition.find({}).select("serviceKey active legacy").lean(),
    distinctSafe(Appointment, "serviceKey"),
    distinctSafe(FixedSchedule, "serviceKey"),
    distinctSafe(User, "creditLots.serviceKey"),
    distinctSafe(User, "history.serviceKey"),
    distinctSafe(WaitlistEntry, "serviceKey"),
    distinctSafe(ServiceSubscription, "serviceKey"),
    distinctSafe(CapacityRule, "serviceKey"),
    distinctSafe(ScheduleBlock, "serviceKeys"),
    distinctSafe(SubscriptionBillingCycle, "serviceKey"),
    distinctSafe(SubscriptionExtraSessionNotice, "serviceKey"),
    distinctSafe(SubscriptionLifecycleNotice, "serviceKey"),
  ]);

  const catalogKeys = cleanKeys(definitions.map((x) => x.serviceKey));

  const sources = {
    appointments: appointmentKeys,
    fixedSchedules: fixedKeys,
    userCreditLots: creditKeys,
    userHistory: historyKeys,
    waitlist: waitlistKeys,
    subscriptions: subscriptionKeys,
    capacityRules: capacityKeys,
    scheduleBlocks: blockKeys,
    billingCycles: cycleKeys,
    extraNotices: extraKeys,
    lifecycleNotices: lifecycleKeys,
  };

  const allUsed = cleanKeys(Object.values(sources).flat());
  const invalidFormat = allUsed.filter((key) => !SERVICE_KEY_RE.test(key));
  const withoutCatalogDefinition = allUsed.filter((key) => !catalogKeys.includes(key));

  return {
    skipped: false,
    readOnly: true,
    catalogKeys,
    sources,
    invalidFormat,
    withoutCatalogDefinition,
    ok: invalidFormat.length === 0 && withoutCatalogDefinition.length === 0,
  };
}

try {
  const inMemory = await runInMemoryTests();
  const dbAudit = await runReadOnlyDbAudit();

  const ok = inMemory.every((row) => row.ok) && (dbAudit.skipped || dbAudit.ok);

  console.log(
    JSON.stringify(
      {
        ok,
        writesToDatabase: false,
        dynamicTestKey: TEST_KEY,
        inMemory,
        dbAudit,
      },
      null,
      2
    )
  );

  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        writesToDatabase: false,
        dynamicTestKey: TEST_KEY,
        error: error?.message || String(error),
        stack: error?.stack || "",
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  try {
    await mongoose.disconnect();
  } catch {
    // no-op
  }
}
