import ActivityLog from "../models/ActivityLog.js";

function toId(value) {
  if (!value) return "";
  try {
    return value.toString();
  } catch {
    return String(value || "");
  }
}

function clean(value) {
  return String(value || "").trim();
}

export function fullNameOf(doc) {
  if (!doc) return "";
  const direct = clean(doc.fullName);
  if (direct) return direct;
  const name = clean(doc.name);
  const lastName = clean(doc.lastName);
  return [name, lastName].filter(Boolean).join(" ").trim();
}

export function buildPersonSnapshot(doc) {
  if (!doc) return { id: "", name: "", email: "", role: "" };
  return {
    id: toId(doc._id || doc.id),
    name: fullNameOf(doc),
    email: clean(doc.email),
    role: clean(doc.role),
  };
}

export function buildActorFromReq(req) {
  return buildPersonSnapshot(req?.user || null);
}

export function buildUserSubject(user) {
  return buildPersonSnapshot(user);
}

export function buildDiff(before = {}, after = {}) {
  return { before: before || {}, after: after || {} };
}

export function compactMeta(meta = {}) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export async function logActivity({
  req,
  category,
  action,
  entity,
  entityId,
  title,
  description,
  subject,
  meta,
  diff,
  deletedSnapshot,
  status = "success",
}) {
  try {
    await ActivityLog.create({
      category: clean(category),
      action: clean(action),
      entity: clean(entity),
      entityId: clean(entityId),
      status: clean(status) || "success",
      actor: buildActorFromReq(req),
      subject: subject ? buildPersonSnapshot(subject) : undefined,
      title: clean(title),
      description: clean(description),
      meta: compactMeta(meta),
      diff: diff || {},
      deletedSnapshot: deletedSnapshot || null,
    });
  } catch (err) {
    console.error("logActivity error:", err?.message || err);
  }
}
