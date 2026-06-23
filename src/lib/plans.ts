import { LimitWindowType, PLAN_TIERS, PlanPeriod, PlanTier } from "@/lib/types";
import { getWindowTheoreticalMultiplier } from "@/lib/limit-regimes";

/**
 * Canonical resolver for the effective capacity multiplier of a plan for a
 * given limit window. Wraps `getWindowTheoreticalMultiplier` so per-window
 * `theoreticalMultipliers` overrides are honoured by every consumer, and
 * centralises the "normalize to the max20 baseline" step that the Limits tab,
 * timeline and plan chart each used to re-derive locally (and inconsistently).
 *
 * - `plan` as a `PlanPeriod` → override-aware (per-window > legacy > tier default).
 * - `plan` as a tier string or `null` → tier default (null ⇒ max20).
 * - `normalizeToMax20` divides by the max20 multiplier so the result is a ratio
 *   vs the Max $200 reference (e.g. Pro ⇒ 1/20 = 0.05).
 */
export function getEffectivePlanMultiplier(
  plan: PlanPeriod | PlanTier | null,
  windowType: LimitWindowType,
  opts: { normalizeToMax20?: boolean } = {}
): number {
  const raw =
    plan && typeof plan === "object"
      ? getWindowTheoreticalMultiplier(plan, windowType)
      : PLAN_TIERS[plan ?? "max20"].multiplier;
  return opts.normalizeToMax20 ? raw / PLAN_TIERS.max20.multiplier : raw;
}

export function getPlanForDate(date: string, periods: PlanPeriod[]): PlanPeriod | null {
  const t = new Date(date).getTime();
  for (const p of periods) {
    const start = new Date(p.startDate).getTime();
    const end = p.endDate ? new Date(p.endDate).getTime() : Infinity;
    if (t >= start && t <= end) return p;
  }
  return null;
}

export function getPlanTierForDate(date: string, periods: PlanPeriod[]): PlanTier | null {
  return getPlanForDate(date, periods)?.tier ?? null;
}

/** Standard ISO week key: YYYY-WNN */
export function weekKeyFromDate(dateStr: string): string {
  const date = new Date(dateStr);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, "0")}`;
}
