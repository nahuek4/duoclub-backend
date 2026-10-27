import express from "express";
import { adminOnly } from "../middleware/auth.js";
import Cycle from "../models/SubscriptionBillingCycle.js";
import Sub from "../models/ServiceSubscription.js";
import User from "../models/User.js";
import Appointment, { effectiveAttendanceStatus } from "../models/Appointment.js";
import ServiceDefinition from "../models/ServiceDefinition.js";
import { sector } from "./financeWork.js";
const fail = text => Object.assign(new Error(text), {
  status: 400
});
const cents = v => Math.round((Number(v) || 0) * 100);
export default function analyticsRoutes({
  financeReport,
  argentinaDay
}) {
  const router = express.Router();
  router.use(adminOnly);
  const wrap = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error("Finance analytics", e);
      res.status(e.status || 500).json({
        error: e.status ? e.message : "No se pudo cargar el informe."
      });
    }
  };
  async function context(req) {
    const month = String(req.query.month || argentinaDay().slice(0, 7));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail("Mes inválido.");
    const group = req.query.group ? sector(req.query.group) : "",
      from = month + "-01",
      stamp = new Date(from + "T12:00:00Z"),
      to = new Date(Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const defs = await ServiceDefinition.find({}).select("serviceKey capacityGroup").lean();
    const map = new Map(defs.map(d => [d.serviceKey, {
      TRAINING: "Training",
      PERFORMANCE: "Performance"
    }[d.capacityGroup] || "General"]));
    const match = key => !group || (map.get(key) || {
      EP: "Training",
      RA: "Performance",
      RF: "Performance",
      SYN: "Performance",
      KD: "Performance"
    }[key] || "General") === group;
    return {
      month,
      from,
      to,
      group,
      match
    };
  }
  router.get("/payments", wrap(async (req, res) => {
    const c = await context(req);
    const [cycles, report] = await Promise.all([Cycle.find({
      periodKey: c.month
    }).populate("user", "name lastName email accountDeactivated").lean(), financeReport({
      from: c.from,
      to: c.to,
      group: c.group
    })]);
    const q = String(req.query.q || "").trim().toLocaleLowerCase("es-AR");
    const items = cycles.filter(x => c.match(x.serviceKey) && x.user).map(x => {
      const expected = cents(x.billing?.total),
        paid = cents(x.billing?.amountPaid),
        received = cents(x.billing?.amountReceived),
        due = cents(x.billing?.balanceDue ?? Math.max(0, (x.billing?.total || 0) - (x.billing?.amountPaid || 0)));
      return {
        id: String(x._id),
        userId: String(x.user._id),
        name: [x.user.name, x.user.lastName].filter(Boolean).join(" "),
        email: x.user.email,
        service: x.serviceKey,
        expected,
        paid,
        received,
        due,
        status: x.billing?.status,
        planStatus: x.lifecycle?.planStatus,
        period: x.periodKey,
        excess: cents(x.billing?.overpaidAmount)
      };
    }).filter(x => !q || [x.name, x.email, x.service].join(" ").toLocaleLowerCase("es-AR").includes(q));
    const billable = items.filter(x => !["cancelled", "written_off"].includes(x.status));
    const people = new Map();
    for (const row of billable) {
      const p = people.get(row.userId) || {
        received: 0,
        due: 0
      };
      p.received += row.received;
      p.due += row.due;
      people.set(row.userId, p);
    }
    const pages = Math.max(1, Math.ceil(items.length / 50)),
      page = Math.min(pages, Math.max(1, Math.floor(Number(req.query.page) || 1)));
    res.json({
      month: c.month,
      group: c.group,
      stats: {
        expected: billable.reduce((n, x) => n + x.expected, 0),
        paid: billable.reduce((n, x) => n + x.paid, 0),
        pending: billable.reduce((n, x) => n + x.due, 0),
        people: people.size,
        paidSomething: [...people.values()].filter(x => x.received > 0).length,
        paidNothing: [...people.values()].filter(x => !x.received && x.due > 0).length,
        fullyPaid: [...people.values()].filter(x => !x.due).length,
        creditBalance: billable.reduce((n, x) => n + x.excess, 0)
      },
      cash: report.stats,
      incomeMethods: report.incomeMethods,
      items: items.slice((page - 1) * 50, page * 50),
      pagination: {
        page,
        pages,
        total: items.length,
        from: items.length ? (page - 1) * 50 + 1 : 0,
        to: Math.min(page * 50, items.length)
      }
    });
  }));
  router.get("/statistics", wrap(async (req, res) => {
    const c = await context(req),
      now = new Date();
    const [subs, users, appointments] = await Promise.all([Sub.find({
      status: {
        $in: ["active", "pending_change"]
      }
    }).select("user serviceKey monthlySessions").lean(), User.find({
      role: "client"
    }).select("name lastName accountDeactivated accountDeactivatedAt createdAt birthDate").lean(), Appointment.find({
      date: {
        $gte: c.from,
        $lte: c.to
      },
      status: {
        $in: ["reserved", "completed"]
      }
    }).select("user date time serviceKey status attendanceStatus").lean()]);
    const active = new Set(users.filter(u => !u.accountDeactivated).map(u => String(u._id)));
    const selected = subs.filter(s => c.match(s.serviceKey) && active.has(String(s.user))),
      ids = new Set(selected.map(s => String(s.user)));
    const members = users.filter(u => ids.has(String(u._id)));
    const byService = new Map(),
      byPlan = new Map();
    for (const s of selected) {
      byService.set(s.serviceKey, (byService.get(s.serviceKey) || 0) + 1);
      const key = s.serviceKey + " · " + s.monthlySessions + " sesiones";
      byPlan.set(key, (byPlan.get(key) || 0) + 1);
    }
    const ages = [];
    for (const u of members) {
      const b = u.birthDate;
      if (!b?.year || !b?.month || !b?.day) continue;
      let age = now.getUTCFullYear() - b.year;
      if (now.getUTCMonth() + 1 < b.month || now.getUTCMonth() + 1 === b.month && now.getUTCDate() < b.day) age--;
      if (age >= 0 && age <= 120) ages.push(age);
    }
    ages.sort((a, b) => a - b);
    const ageBands = [{
      label: "Menores de 18",
      value: 0
    }, {
      label: "18–25",
      value: 0
    }, {
      label: "26–35",
      value: 0
    }, {
      label: "36–45",
      value: 0
    }, {
      label: "46–55",
      value: 0
    }, {
      label: "56–65",
      value: 0
    }, {
      label: "66 o más",
      value: 0
    }];
    for (const age of ages) ageBands[age < 18 ? 0 : age <= 25 ? 1 : age <= 35 ? 2 : age <= 45 ? 3 : age <= 55 ? 4 : age <= 65 ? 5 : 6].value++;
    const selectedAppointments = appointments.filter(a => c.match(a.serviceKey));
    let present = 0,
      absent = 0;
    const byTime = new Map();
    for (const a of selectedAppointments) {
      const status = effectiveAttendanceStatus(a, now);
      if (status === "present") present++;
      if (status === "absent") absent++;
      byTime.set(a.time, (byTime.get(a.time) || 0) + 1);
    }
    const monthly = [];
    for (let i = 5; i >= 0; i--) {
      const stamp = new Date(Date.UTC(Number(c.month.slice(0, 4)), Number(c.month.slice(5, 7)) - 1 - i, 1)),
        key = stamp.toISOString().slice(0, 7);
      const joined = users.filter(u => argentinaDay(u.createdAt).slice(0, 7) === key && (!c.group || ids.has(String(u._id))));
      monthly.push({
        month: key,
        joined: joined.length,
        stillActive: joined.filter(u => !u.accountDeactivated && ids.has(String(u._id))).length,
        deactivated: users.filter(u => u.accountDeactivatedAt && argentinaDay(u.accountDeactivatedAt).slice(0, 7) === key && (!c.group || subs.some(s => String(s.user) === String(u._id) && c.match(s.serviceKey)))).length
      });
    }
    res.json({
      month: c.month,
      group: c.group,
      stats: {
        members: members.length,
        memberships: selected.length,
        present,
        absent,
        reservations: selectedAppointments.length,
        knownAges: ages.length,
        missingAges: members.length - ages.length,
        averageAge: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null
      },
      services: [...byService].map(([label, value]) => ({
        label,
        value
      })),
      plans: [...byPlan].map(([label, value]) => ({
        label,
        value
      })),
      ageBands,
      byTime: [...byTime].map(([label, value]) => ({
        label,
        value
      })).sort((a, b) => a.label.localeCompare(b.label)),
      monthly,
      notes: ["Membresías y edades muestran la situación actual. Reservas y asistencia corresponden al mes elegido.", "Las altas y bajas por grupo requieren historial de pertenencia. Con un grupo seleccionado, las altas se limitan a sus miembros actuales; no reconstruyen los pases históricos.", "La app todavía no registra sexo, origen de captación ni traspasos entre sectores como eventos. Esos indicadores no se estiman."]
    });
  }));
  router.get("/monthly-report", wrap(async (req, res) => {
    const c = await context(req);
    const months = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(Date.UTC(Number(c.month.slice(0, 4)), Number(c.month.slice(5, 7)) - 1 - i, 1)),
        month = date.toISOString().slice(0, 7),
        from = month + "-01",
        to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      months.push({
        month,
        from,
        to
      });
    }
    const reports = await Promise.all(months.map(m => financeReport({
      from: m.from,
      to: m.to,
      group: c.group
    })));
    const current = reports.at(-1),
      previous = reports.at(-2);
    const metrics = [["Ingresos registrados", "incomeCents"], ["Gastos y mano de obra", "expenseCents"], ["Mano de obra", "laborCents"], ["Resultado registrado", "resultCents"]].map(([label, key]) => ({
      label,
      current: current.stats.movements ? current.stats[key] : null,
      previous: previous.stats.movements ? previous.stats[key] : null,
      difference: current.stats.movements && previous.stats.movements ? current.stats[key] - previous.stats[key] : null,
      average: reports.slice(0, -1).some(r => r.stats.movements) ? Math.round(reports.slice(0, -1).filter(r => r.stats.movements).reduce((n, r) => n + r.stats[key], 0) / reports.slice(0, -1).filter(r => r.stats.movements).length) : null
    }));
    const today = argentinaDay(),
      inProgress = c.month === today.slice(0, 7),
      elapsed = inProgress ? Number(today.slice(8)) : Number(c.to.slice(8));
    res.json({
      month: c.month,
      group: c.group,
      previousMonth: months.at(-2).month,
      inProgress,
      elapsed,
      metrics,
      unpricedMinutes: current.stats.unpricedMinutes,
      averagePerDay: current.stats.movements ? Math.round(current.stats.resultCents / elapsed) : null,
      previousAveragePerDay: previous.stats.movements ? Math.round(previous.stats.resultCents / Number(months.at(-2).to.slice(8))) : null,
      incomeMethods: current.incomeMethods,
      series: months.map((m, i) => ({
        label: m.month,
        value: reports[i].stats.movements ? reports[i].stats.resultCents : null,
        unpricedMinutes: reports[i].stats.unpricedMinutes
      })),
      notes: ["Ingresos por fecha de cobro; las cuotas del mes se consultan en Pagos.", "Resultado = ingresos registrados menos gastos y costo de horas con tarifa. No representa saldo bancario ni ganancia contable definitiva.", "Un mes sin movimientos cargados no acredita que el club haya tenido actividad cero. La serie empieza con los datos de esta app; no se importaron históricos.", "No se calcula reparto entre socios: no hay porcentajes ni socios configurados."]
    });
  }));
  return router;
}
