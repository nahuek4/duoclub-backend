import express from "express";
import mongoose from "mongoose";
import FinanceEntry from "../models/FinanceEntry.js";
import FinanceHours from "../models/FinanceHours.js";
import FinanceRate from "../models/FinanceRate.js";
import FinanceSettings from "../models/FinanceSettings.js";
import User from "../models/User.js";
import { adminOnly } from "../middleware/auth.js";
const error = (text, status = 400) => Object.assign(new Error(text), {
  status
});
const isAdmin = req => req.user.role === "admin";
const name = u => [u?.name, u?.lastName].filter(Boolean).join(" ");
export async function financeConfiguration() {
  return (await FinanceSettings.findById("main").lean()) || new FinanceSettings({
    _id: "main"
  }).toObject();
}
export function sector(value = "") {
  const result = {
    TRAINING: "Training",
    PERFORMANCE: "Performance",
    GENERAL: "General"
  }[String(value || "General").trim().toUpperCase()];
  if (!result) throw error("Grupo inválido. Elegí Training, Performance o General.");
  return result;
}
export function groupFilter(value) {
  if (!value) return {};
  const group = sector(value);
  return group === "General" ? {
    $or: [{
      section: "General"
    }, {
      section: {
        $exists: false
      }
    }, {
      section: null
    }, {
      section: ""
    }]
  } : {
    section: group
  };
}
export async function laborRows(from, to, includeVoided = false, group = "") {
  const [hours, rates] = await Promise.all([FinanceHours.find({
    ...groupFilter(group),
    date: {
      $gte: from,
      $lte: to
    },
    ...(includeVoided ? {} : {
      status: "active"
    })
  }).populate("user", "name lastName").lean(), FinanceRate.find({
    month: {
      $lte: to.slice(0, 7)
    }
  }).sort({
    month: -1
  }).lean()]);
  const histories = new Map(),
    cache = new Map();
  for (const r of rates) {
    const key = String(r.user) + ":" + r.kind;
    const list = histories.get(key) || [];
    list.push(r);
    histories.set(key, list);
  }
  return hours.map(h => {
    const key = String(h.user?._id) + ":" + h.kind,
      month = h.date.slice(0, 7),
      cacheKey = key + ":" + month;
    if (!cache.has(cacheKey)) cache.set(cacheKey, (histories.get(key) || []).find(r => r.month <= month)?.rateCents);
    const rate = cache.get(cacheKey);
    return {
      id: String(h._id),
      source: "labor",
      section: h.section || "General",
      type: "expense",
      date: h.date,
      sortAt: new Date(h.date + "T12:00:00-03:00").getTime(),
      amountCents: rate === undefined ? 0 : Math.round(h.minutes * rate / 60),
      rateCents: rate ?? null,
      minutes: h.minutes,
      category: "Mano de obra",
      description: name(h.user) + " · " + h.kind,
      method: "ACCRUED",
      reference: "Horas registradas",
      status: h.status,
      unpriced: rate === undefined
    };
  });
}
export default function createWorkRoutes({
  argentinaDay,
  resolveFinanceRange,
  normalizeEntry
}) {
  const router = express.Router();
  const wrap = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 500).json({
        error: e.status ? e.message : "No se pudo completar la operación."
      });
    }
  };
  function ownToday(req, row) {
    if (isAdmin(req)) return;
    const today = argentinaDay();
    if (String(row.createdBy) !== String(req.user._id) || row.date !== today || argentinaDay(row.createdAt) !== today) throw error("Solo podés modificar tus propios registros creados hoy.", 403);
  }
  function rev(body) {
    if (!Number.isInteger(body.revision) || body.revision < 0) throw error("Volvé a abrir el registro antes de corregirlo.");
    return body.revision;
  }
  router.get("/desk", wrap(async (req, res) => {
    const today = argentinaDay();
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const filter = {
      ...groupFilter(req.query.group),
      createdBy: req.user._id,
      date: today,
      createdAt: {
        $gte: new Date(today + "T00:00:00-03:00"),
        $lt: new Date(new Date(today + "T00:00:00-03:00").getTime() + 86400000)
      }
    };
    const [entries, hours, configuration] = await Promise.all([FinanceEntry.find(filter).sort({
      createdAt: -1
    }).lean(), FinanceHours.find({
      ...filter,
      user: req.user._id
    }).sort({
      createdAt: -1
    }).lean(), financeConfiguration()]);
    const pages = Math.max(1, Math.ceil(entries.length / 50)),
      safe = Math.min(page, pages);
    res.json({
      today,
      group: req.query.group ? sector(req.query.group) : "",
      entries: entries.slice((safe - 1) * 50, safe * 50).map(({
        _id,
        type,
        date,
        amountCents,
        category,
        description,
        method,
        section,
        paidBy,
        status,
        revision
      }) => ({
        _id,
        type,
        date,
        amountCents,
        category,
        description,
        method,
        section,
        paidBy,
        status,
        revision: revision || 0
      })),
      hours: hours.map(({
        _id,
        date,
        kind,
        minutes,
        note,
        section,
        status,
        revision
      }) => ({
        _id,
        date,
        kind,
        minutes,
        note,
        section,
        status,
        revision: revision || 0
      })),
      configuration: {
        categories: configuration.categories,
        sections: configuration.sections,
        payers: configuration.payers,
        hourKinds: configuration.hourKinds
      },
      pagination: {
        page: safe,
        pages,
        total: entries.length,
        from: entries.length ? (safe - 1) * 50 + 1 : 0,
        to: Math.min(safe * 50, entries.length)
      }
    });
  }));
  router.patch("/entries/:id", wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw error("Registro inválido.");
    const previous = await FinanceEntry.findById(req.params.id).lean();
    if (!previous) throw error("Registro no encontrado.", 404);
    ownToday(req, previous);
    if (previous.status !== "active") throw error("Un registro anulado no se modifica.", 409);
    const payload = normalizeEntry({
      ...req.body,
      requestKey: previous.requestKey
    });
    if (!isAdmin(req) && payload.date !== argentinaDay()) throw error("Solo podés cargar la fecha de hoy.", 403);
    const revision = rev(req.body);
    const item = await FinanceEntry.findOneAndUpdate({
      _id: previous._id,
      revision,
      ...(!isAdmin(req) ? {
        createdBy: req.user._id,
        date: argentinaDay(),
        createdAt: {
          $gte: new Date(argentinaDay() + "T00:00:00-03:00")
        }
      } : {}),
      status: "active"
    }, {
      $set: payload,
      $inc: {
        revision: 1
      },
      $push: {
        history: {
          at: new Date(),
          actor: req.user._id,
          before: Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "history")),
          action: "edit"
        }
      }
    }, {
      new: true,
      runValidators: true
    });
    if (!item) throw error("El registro cambió. Actualizá antes de volver a guardar.", 409);
    res.json({
      ok: true,
      item
    });
  }));
  router.get("/configuration", adminOnly, wrap(async (req, res) => res.json(await financeConfiguration())));
  router.put("/configuration", adminOnly, wrap(async (req, res) => {
    const fields = {};
    for (const key of ["categories", "sections", "payers", "hourKinds"]) {
      const list = req.body[key];
      if (!Array.isArray(list) || !list.length || list.length > 40 || list.some(v => typeof v !== "string" || !v.trim() || v.length > 80)) throw error("Cada lista debe tener entre 1 y 40 nombres, de hasta 80 caracteres.");
      fields[key] = [...new Set(list.map(v => v.trim()))];
    }
    if (fields.sections.length !== 3 || !["General", "Training", "Performance"].every(k => fields.sections.includes(k))) throw error("Los grupos son General, Training y Performance.");
    const item = await FinanceSettings.findByIdAndUpdate("main", {
      $set: {
        ...fields,
        updatedBy: req.user._id
      }
    }, {
      new: true,
      upsert: true,
      runValidators: true
    });
    res.json(item);
  }));
  router.get("/rates", adminOnly, wrap(async (req, res) => {
    const month = String(req.query.month || argentinaDay().slice(0, 7));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw error("Mes inválido.");
    const [people, rates, configuration] = await Promise.all([User.find({
      role: {
        $in: ["staff", "admin"]
      }
    }).select("name lastName role accountDeactivated").sort({
      name: 1
    }).lean(), FinanceRate.find({
      month: {
        $lte: month
      }
    }).sort({
      month: -1
    }).lean(), financeConfiguration()]);
    const effective = new Map();
    for (const rate of rates) {
      const key = String(rate.user) + ":" + rate.kind;
      if (!effective.has(key)) effective.set(key, {
        ...rate,
        inherited: rate.month !== month
      });
    }
    res.json({
      month,
      people: people.map(p => ({
        id: String(p._id),
        name: name(p)+(p.accountDeactivated?" (de baja)":""),
        role: p.role,
        deactivated:!!p.accountDeactivated
      })),
      rates: [...effective.values()],
      configuration
    });
  }));
  router.put("/rates", adminOnly, wrap(async (req, res) => {
    const {
      user,
      kind,
      month
    } = req.body;
    if (!mongoose.isValidObjectId(user) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw error("Persona o mes inválido.");
    const person = await User.findOne({
      _id: user,
      role: {
        $in: ["staff", "admin"]
      }
    });
    if (!person) throw error("Persona no encontrada.");
    const config = await financeConfiguration();
    if (!config.hourKinds.includes(kind) && !(await FinanceHours.exists({
      user,
      kind,
      date: {
        $gte: month + "-01",
        $lte: month + "-31"
      }
    }))) throw error("Tipo de hora no configurado.");
    const value = String(req.body.rate).trim();
    const rateCents = /^0([.,]0{1,2})?$/.test(value) ? 0 : (() => {
      if (!/^\d{1,7}([.,]\d{1,2})?$/.test(value)) throw error("Tarifa inválida.");
      return Math.round(Number(value.replace(",", ".")) * 100);
    })();
    if (!Number.isSafeInteger(rateCents) || rateCents < 0 || rateCents > 1000000000) throw error("Tarifa fuera de rango.");
    const item = await FinanceRate.findOneAndUpdate({
      user,
      kind,
      month
    }, {
      $set: {
        rateCents,
        updatedBy: req.user._id
      }
    }, {
      upsert: true,
      new: true,
      runValidators: true
    });
    res.json({
      ok: true,
      item
    });
  }));
  router.get("/work-hours", adminOnly, wrap(async (req, res) => {
    const range = resolveFinanceRange(req.query);
    const filter = {
      ...groupFilter(req.query.group),
      date: {
        $gte: range.fromDay,
        $lte: range.toDay
      }
    };
    if (req.query.user) {
      if (!mongoose.isValidObjectId(req.query.user)) throw error("Persona inválida.");
      filter.user = req.query.user;
    }
    const [items, costs] = await Promise.all([FinanceHours.find(filter).populate("user", "name lastName").sort({
      date: -1,
      createdAt: -1
    }).lean(), laborRows(range.fromDay, range.toDay, true, req.query.group)]);
    const costMap = new Map(costs.map(x => [x.id, x]));
    const byPerson = new Map();
    for (const h of items.filter(x => x.status === "active")) {
      const id = String(h.user?._id),
        cost = costMap.get(String(h._id));
      const summary = byPerson.get(id) || {
        id,
        name: name(h.user),
        minutes: 0,
        amountCents: 0,
        unpricedMinutes: 0
      };
      summary.minutes += h.minutes;
      summary.amountCents += cost?.amountCents || 0;
      if (cost?.unpriced) summary.unpricedMinutes += h.minutes;
      byPerson.set(id, summary);
    }
    const pages = Math.max(1, Math.ceil(items.length / 50)),
      page = Math.min(pages, Math.max(1, Math.floor(Number(req.query.page) || 1)));
    res.json({
      range: {
        from: range.fromDay,
        to: range.toDay
      },
      group: req.query.group ? sector(req.query.group) : "",
      people: [...byPerson.values()],
      items: items.slice((page - 1) * 50, page * 50).map(h => ({
        ...h,
        cost: costMap.get(String(h._id))
      })),
      pagination: {
        page,
        pages,
        total: items.length,
        from: items.length ? (page - 1) * 50 + 1 : 0,
        to: Math.min(page * 50, items.length)
      }
    });
  }));
  async function hourPayload(req) {
    const body = req.body,
      user = isAdmin(req) ? body.user : req.user.id,
      date = String(body.date || "");
    if (!mongoose.isValidObjectId(user)) throw error("Elegí una persona.");
    resolveFinanceRange({
      from: date,
      to: date
    });
    if (!date || date > argentinaDay()) throw error("Ingresá hoy o una fecha anterior.");
    if (!isAdmin(req) && date !== argentinaDay()) throw error("Solo podés cargar horas de hoy.", 403);
    const person = await User.findOne({
      _id: user,
      role: {
        $in: ["staff", "admin"]
      },
      ...(!isAdmin(req)?{accountDeactivated:{$ne:true}}:{})
    });
    if (!person) throw error("Persona no válida.");
    const config = await financeConfiguration();
    if (!config.hourKinds.includes(body.kind) && !(req.params.id && (await FinanceHours.exists({
      _id: req.params.id,
      kind: body.kind
    })))) throw error("Elegí un tipo de hora configurado.");
    const raw = String(body.hours ?? "").replace(",", ".");
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(raw)) throw error("Ingresá horas positivas, con hasta dos decimales.");
    const minutes = Math.round(Number(raw) * 60);
    if (minutes < 1 || minutes > 1440) throw error("Las horas deben ser mayores a cero y hasta 24.");
    const note = String(body.note || "").trim();
    if (note.length > 500) throw error("La nota admite hasta 500 caracteres.");
    return {
      user,
      date,
      kind: body.kind,
      minutes,
      note,
      section: sector(body.section)
    };
  }
  router.post("/work-hours", wrap(async (req, res) => {
    const payload = await hourPayload(req),
      requestKey = String(req.body.requestKey || "");
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) throw error("Identificación inválida.");
    const key = {
      createdBy: req.user._id,
      requestKey
    };
    const respond = (h, reused) => {
      if (["date", "kind", "minutes", "note", "section"].some(k => h[k] !== payload[k]) || String(h.user) !== String(payload.user)) throw error("Este envío ya se utilizó con otro contenido.", 409);
      return res.status(reused ? 200 : 201).json({
        ok: true,
        reused,
        item: {
          _id: h._id,
          date: h.date,
          kind: h.kind,
          minutes: h.minutes,
          note: h.note,
          section: h.section,
          status: h.status,
          revision: h.revision || 0
        }
      });
    };
    let item = await FinanceHours.findOne(key);
    if (item) return respond(item, true);
    try {
      item = await FinanceHours.create({
        ...payload,
        ...key
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
      item = await FinanceHours.findOne(key);
      return respond(item, true);
    }
    return respond(item, false);
  }));
  router.patch("/work-hours/:id", wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw error("Registro inválido.");
    const previous = await FinanceHours.findById(req.params.id).lean();
    if (!previous) throw error("Registro no encontrado.", 404);
    ownToday(req, previous);
    if (!isAdmin(req) && String(previous.user) !== String(req.user._id)) throw error("No autorizado.", 403);
    const revision = rev(req.body);
    const payload = req.body.void ? {
      status: "void"
    } : await hourPayload(req);
    const item = await FinanceHours.findOneAndUpdate({
      _id: previous._id,
      revision,
      status: "active",
      ...(!isAdmin(req) ? {
        createdBy: req.user._id,
        date: argentinaDay(),
        createdAt: {
          $gte: new Date(argentinaDay() + "T00:00:00-03:00")
        }
      } : {})
    }, {
      $set: payload,
      $inc: {
        revision: 1
      },
      $push: {
        history: {
          at: new Date(),
          actor: req.user._id,
          before: Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "history")),
          action: req.body.void ? "void" : "edit"
        }
      }
    }, {
      new: true,
      runValidators: true
    });
    if (!item) throw error("El registro cambió. Actualizá la lista.", 409);
    res.json({
      ok: true,
      item: {
        _id: item._id,
        date: item.date,
        kind: item.kind,
        minutes: item.minutes,
        note: item.note,
        section: item.section,
        status: item.status,
        revision: item.revision
      }
    });
  }));
  return router;
}
