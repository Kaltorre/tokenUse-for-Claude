import { DerivedLimits, Utilization, Bottleneck, PeakStatus, FiveHourWindow, PromoPeriod, DEFAULT_LIMITS_5H, DEFAULT_LIMITS_WEEKLY, WeeklyBucket } from "./types";
import { matchesPromoScheduleInPoland } from "./promo-time";

const STORAGE_KEY = "claude-usage-derived-limits";
const WEEKLY_STORAGE_KEY = "claude-usage-weekly-limits";

// --- Promo schedule helpers ---

/**
 * Returns true if `date` falls within the given promo schedule.
 * All hour/weekday comparisons use Polish time (`Europe/Warsaw`).
 * Schedule hours stored in PromoPanel are expected to be Polish hours.
 */
function matchesSchedule(date: Date, schedule: import("./types").PromoSchedule): boolean {
  return matchesPromoScheduleInPoland(date, schedule);
}

/**
 * Returns the effective promo multiplier for a timestamp.
 * When multiple promo periods overlap, the highest multiplier wins.
 * Returns 1 (no promo) if no period matches.
 */
export function getActivePromoMultiplier(
  isoTimestamp: string,
  promos: PromoPeriod[]
): number {
  const t = new Date(isoTimestamp);
  const tMs = t.getTime();

  let maxMultiplier = 1;

  for (const period of promos) {
    const from = new Date(period.dateFrom).getTime();
    const to = new Date(period.dateTo).getTime();
    if (tMs < from || tMs > to) continue;

    if (matchesSchedule(t, period.schedule)) {
      if (period.multiplier > maxMultiplier) {
        maxMultiplier = period.multiplier;
      }
    }
  }

  return maxMultiplier;
}

/**
 * Returns true if the given ISO timestamp falls within any promo period
 * and matches the period's schedule. When multiple periods apply, the one
 * with the highest multiplier takes effect (see getActivePromoMultiplier).
 */
export function isInPromoSchedule(
  isoTimestamp: string,
  promos: PromoPeriod[]
): boolean {
  return getActivePromoMultiplier(isoTimestamp, promos) > 1;
}

/** @deprecated Use isInPromoSchedule with promos array instead */
export function isInPromoRange(isoTimestamp: string): boolean {
  // Kept for backward compatibility with components that haven't been updated yet
  const PROMO_START = new Date("2026-03-13T00:00:00+01:00").getTime();
  const PROMO_END = new Date("2026-03-28T23:59:00+01:00").getTime();
  const t = new Date(isoTimestamp).getTime();
  return t >= PROMO_START && t <= PROMO_END;
}

type UsageForNormalization = {
  output: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  cost?: number;
};

export type PromoNormalizationMode = "apply" | "ignore";

export function rangeHasPromoUsage(
  peakStatus: PeakStatus,
  rangeStart: string,
  peakSplit?: FiveHourWindow["peakSplit"] | WeeklyBucket["peakSplit"],
  promos: PromoPeriod[] = []
): boolean {
  if ((peakSplit?.offPeak.totalTokens ?? 0) > 0) {
    return true;
  }

  if (peakStatus !== "off-peak") {
    return false;
  }

  if (promos.length > 0) {
    return getActivePromoMultiplier(rangeStart, promos) > 1;
  }

  return isInPromoRange(rangeStart);
}

function inferBonusMultiplier(
  windowStart: string,
  peakStatus: PeakStatus,
  peakSplit?: FiveHourWindow["peakSplit"],
  promos: PromoPeriod[] = []
): number {
  const activeAtStart =
    promos.length > 0 ? getActivePromoMultiplier(windowStart, promos) : isInPromoRange(windowStart) ? 2 : 1;
  const hasBonus = rangeHasPromoUsage(peakStatus, windowStart, peakSplit, promos) || activeAtStart > 1;
  if (!hasBonus) return 1;

  if (activeAtStart > 1) return activeAtStart;

  const configured = [...new Set(promos.map((promo) => promo.multiplier).filter((m) => m > 1))];
  if (configured.length === 1) return configured[0];

  return 2;
}

export function normalizeUsageToBase(
  usage: UsageForNormalization,
  peakStatus: PeakStatus,
  windowStart: string,
  peakSplit?: FiveHourWindow["peakSplit"],
  promos: PromoPeriod[] = [],
  options?: { promoMode?: PromoNormalizationMode }
): Required<UsageForNormalization> {
  const cost = usage.cost ?? 0;
  const promoMode = options?.promoMode ?? "apply";

  if (promoMode === "ignore") {
    return {
      output: usage.output,
      input: usage.input,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      total: usage.total,
      cost,
    };
  }

  if (peakSplit && peakSplit.offPeak.totalTokens > 0) {
    const bonusMultiplier = inferBonusMultiplier(windowStart, peakStatus, peakSplit, promos);
    return {
      output: peakSplit.peak.outputTokens + peakSplit.offPeak.outputTokens / bonusMultiplier,
      input: peakSplit.peak.inputTokens + peakSplit.offPeak.inputTokens / bonusMultiplier,
      cacheWrite:
        peakSplit.peak.cacheCreationTokens + peakSplit.offPeak.cacheCreationTokens / bonusMultiplier,
      cacheRead: peakSplit.peak.cacheReadTokens + peakSplit.offPeak.cacheReadTokens / bonusMultiplier,
      total: peakSplit.peak.totalTokens + peakSplit.offPeak.totalTokens / bonusMultiplier,
      cost: peakSplit.peak.totalCost + peakSplit.offPeak.totalCost / bonusMultiplier,
    };
  }

  if (peakStatus === "off-peak") {
    const bonusMultiplier = inferBonusMultiplier(windowStart, peakStatus, peakSplit, promos);
    if (bonusMultiplier > 1) {
      return {
        output: usage.output / bonusMultiplier,
        input: usage.input / bonusMultiplier,
        cacheWrite: usage.cacheWrite / bonusMultiplier,
        cacheRead: usage.cacheRead / bonusMultiplier,
        total: usage.total / bonusMultiplier,
        cost: cost / bonusMultiplier,
      };
    }
  }

  return {
    output: usage.output,
    input: usage.input,
    cacheWrite: usage.cacheWrite,
    cacheRead: usage.cacheRead,
    total: usage.total,
    cost,
  };
}

/** Get effective limits for a window based on peak status */
function getEffectiveLimits(
  limits: DerivedLimits,
  peakStatus: PeakStatus,
  windowStart: string,
  mode: "5h" | "weekly" = "5h",
  peakSplit?: FiveHourWindow["peakSplit"],
  promos?: PromoPeriod[]
): { output: number; inout: number; total: number } | null {
  const base =
    mode === "weekly" && limits.weeklyOutputLimit != null
      ? {
          output: limits.weeklyOutputLimit!,
          inout: limits.weeklyInputOutputLimit!,
          total: limits.weeklyTotalLimit!,
        }
      : {
          output: limits.outputLimit,
          inout: limits.inputOutputLimit,
          total: limits.totalLimit,
        };

  if (base.output <= 0 || base.inout <= 0 || base.total <= 0) return null;
  return base;
}

/** Calculate utilization for a token bucket (5h window or weekly bucket) */
export function calcUtilization(
  tokens: {
    outputTokens: number;
    inputTokens: number;
    totalTokens: number;
    totalCost?: number;
  },
  limits: DerivedLimits | null,
  peakStatus: PeakStatus,
  windowStart: string,
  mode: "5h" | "weekly" = "5h",
  peakSplit?: FiveHourWindow["peakSplit"],
  promos?: PromoPeriod[],
  planMultiplier: number = 1,
  options?: { promoMode?: PromoNormalizationMode }
): Utilization | null {
  if (!limits) return null;

  const effective = getEffectiveLimits(limits, peakStatus, windowStart, mode, peakSplit, promos);
  if (!effective) return null;

  // Cost limit: prefer weekly when in weekly mode
  let costCap =
    mode === "weekly" && limits.weeklyCostLimit != null
      ? limits.weeklyCostLimit
      : limits.costLimit;
  if (!costCap || costCap <= 0) costCap = mode === "weekly" ? DEFAULT_LIMITS_WEEKLY.costLimit : DEFAULT_LIMITS_5H.costLimit;

  // Scale limits by plan tier multiplier
  if (planMultiplier > 0 && planMultiplier !== 1) {
    effective.output *= planMultiplier;
    effective.inout *= planMultiplier;
    effective.total *= planMultiplier;
    costCap *= planMultiplier;
  }

  const normalized = normalizeUsageToBase(
    {
      output: tokens.outputTokens,
      input: tokens.inputTokens,
      cacheWrite: 0,
      cacheRead: 0,
      total: tokens.totalTokens,
      cost: tokens.totalCost,
    },
    peakStatus,
    windowStart,
    peakSplit,
    promos,
    options
  );

  const outputPct = (normalized.output / effective.output) * 100;
  const inoutPct =
    ((normalized.input + normalized.output) / effective.inout) * 100;
  const totalPct = (normalized.total / effective.total) * 100;
  const costPct = normalized.cost > 0 && costCap > 0
    ? (normalized.cost / costCap) * 100
    : 0;

  let bottleneck: Bottleneck = "output";
  let effectivePct = outputPct;

  if (inoutPct > effectivePct) {
    effectivePct = inoutPct;
    bottleneck = "inout";
  }
  if (totalPct > effectivePct) {
    effectivePct = totalPct;
    bottleneck = "total";
  }
  if (costPct > effectivePct) {
    effectivePct = costPct;
    bottleneck = "cost";
  }

  return {
    outputPct: Math.round(outputPct * 10) / 10,
    inoutPct: Math.round(inoutPct * 10) / 10,
    totalPct: Math.round(totalPct * 10) / 10,
    costPct: Math.round(costPct * 10) / 10,
    effectivePct: Math.round(effectivePct * 10) / 10,
    bottleneck,
  };
}

/** Bottleneck short labels */
export const BOTTLENECK_LABELS: Record<Bottleneck, string> = {
  output: "OUT",
  inout: "I/O",
  total: "TOT",
  cost: "COST",
};

export const BOTTLENECK_COLORS: Record<Bottleneck, string> = {
  output: "var(--accent-green)",
  inout: "var(--accent-blue)",
  total: "var(--accent-cyan)",
  cost: "var(--accent-orange)",
};

// --- localStorage persistence ---

export function saveDerivedLimits(limits: DerivedLimits): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(limits));
  } catch {}
}

export function loadDerivedLimits(): DerivedLimits | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DerivedLimits;
  } catch {
    return null;
  }
}

export function saveWeeklyLimits(limits: Partial<DerivedLimits>): void {
  try {
    const existing = loadDerivedLimits();
    if (existing) {
      saveDerivedLimits({ ...existing, ...limits });
    }
  } catch {}
}
