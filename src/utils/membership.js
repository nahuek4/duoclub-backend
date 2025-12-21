// backend/src/utils/membership.js

export function membershipRulesForTier(tier) {
  const t = String(tier || "").toUpperCase();

  if (t === "PLUS") {
    return {
      cancelMinHours: 12,
      cancelLimit: 2,
      creditsExpireDays: 40,
    };
  }

  // BASIC
  return {
    cancelMinHours: 24,
    cancelLimit: 1,
    creditsExpireDays: 30,
  };
}

export function startOrExtendMembership(user, { tier = "PLUS", days = 30 }) {
  const now = new Date();
  const t = String(tier || "").toUpperCase();

  const rules = membershipRulesForTier(t);

  // Si ya tenía membresía activa, extendemos desde el expiresAt actual
  const currentExp = user?.membership?.expiresAt ? new Date(user.membership.expiresAt) : null;
  const base = currentExp && currentExp > now ? currentExp : now;

  const expiresAt = new Date(base.getTime() + Number(days) * 24 * 60 * 60 * 1000);

  user.membership = user.membership || {};
  user.membership.tier = t;
  user.membership.active = true;
  user.membership.expiresAt = expiresAt;

  user.membership.cancelMinHours = rules.cancelMinHours;
  user.membership.cancelLimit = rules.cancelLimit;
  user.membership.creditsExpireDays = rules.creditsExpireDays;

  // ciclo mensual (para contar cancelaciones)
  // si no hay ciclo o está vencido, reiniciamos
  const cs = user.membership.cycleStartAt ? new Date(user.membership.cycleStartAt) : null;
  const cycleEnd = cs ? new Date(cs.getTime() + 30 * 24 * 60 * 60 * 1000) : null;

  if (!cs || !cycleEnd || cycleEnd <= now) {
    user.membership.cycleStartAt = now;
    user.membership.cancelsUsed = 0;
  }

  return user;
}
