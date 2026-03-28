import { DerivedLimits, Utilization, Bottleneck, PeakStatus, FiveHourWindow, PromoPeriod } from "./types";

const STORAGE_KEY = "claude-usage-derived-limits";
const WEEKLY_STORAGE_KEY = "claude-usage-weekly-limits";

// --- Promo schedule helpers ---

/** Day of month for the Nth occurrence of a weekday (0=Sun) in a given year/month (0-based). */
function nthWeekdayOfMonthUTC(year: number, month: number, weekday: number, nth: number): number {
  const firstDayOfMonth = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const dayOffset = (weekday - firstDayOfMonth + 7) % 7;
  return 1 + dayOffset + (nth - 1) * 7;
}

/** Returns the ET UTC offset in hours (4 = EDT, 5 = EST) for a given UTC Date.
 * US DST: 2nd Sunday of March at 2:00 am ET → 1st Sunday of November at 2:00 am ET.
 * 2:00 am EST = 07:00 UTC; 2:00 am EDT = 06:00 UTC.
 */
function etOffsetHours(date: Date): 4 | 5 {
  const yr = date.getUTCFullYear();
  const dstStartDay = nthWeekdayOfMonthUTC(yr, 2, 0, 2); // 2nd Sunday of March
  const dstEndDay   = nthWeekdayOfMonthUTC(yr, 10, 0, 1); // 1st Sunday of November
  const dstStart = Date.UTC(yr, 2, dstStartDay, 7);  // 07:00 UTC = 2:00 am EST
  const dstEnd   = Date.UTC(yr, 10, dstEndDay,  6);  // 06:00 UTC = 2:00 am EDT
  return (date.getTime() >= dstStart && date.getTime() < dstEnd) ? 4 : 5;
}

/** Returns the ET hour (0–23) for a UTC Date. */
function etHour(date: Date): number {
  return (24 + date.getUTCHours() - etOffsetHours(date)) % 24;
}

/** Returns the ET day-of-week (0=Sun) for a UTC Date. */
function etDay(date: Date): number {
  return new Date(date.getTime() - etOffsetHours(date) * 3_600_000).getUTCDay();
}

/**
 * Returns true if `date` falls within the given promo schedule.
 * All hour/weekday comparisons use Eastern Time (ET = UTC-4 EDT / UTC-5 EST).
 * Schedule hours stored in PromoPanel are expected to be ET hours.
 */
function matchesSchedule(date: Date, schedule: import("./types").PromoSchedule): boolean {
  if (schedule.type === "all-day-all-week") return true;

  const hour = etHour(date); // ET hour (UTC-4 EDT / UTC-5 EST)

  if (schedule.type === "daily-hours") {
    return hour >= schedule.hourFrom && hour < schedule.hourTo;
  }

  if (schedule.type === "weekdays") {
    const day = etDay(date); // 0=Sun, ET
    if (!schedule.days.includes(day)) return false;
    if (schedule.hourFrom != null && schedule.hourTo != null) {
      const inRange = hour >= schedule.hourFrom && hour < schedule.hourTo;
      return schedule.excludeHours ? !inRange : inRange;
    }
    return true;
  }

  return false;
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
  const PROMO_START = new Date("2026-03-13T00:00:00-04:00").getTime();
  const PROMO_END = new Date("2026-03-29T03:59:00-04:00").getTime();
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

function inferBonusMultiplier(
  windowStart: string,
  peakStatus: PeakStatus,
  peakSplit?: FiveHourWindow["peakSplit"],
  promos: PromoPeriod[] = []
): number {
  const activeAtStart =
    promos.length > 0 ? getActivePromoMultiplier(windowStart, promos) : isInPromoRange(windowStart) ? 2 : 1;
  const hasBonus = !!peakSplit?.offPeak.totalTokens || activeAtStart > 1;
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
  promos: PromoPeriod[] = []
): Required<UsageForNormalization> {
  const cost = usage.cost ?? 0;

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
  },
  limits: DerivedLimits | null,
  peakStatus: PeakStatus,
  windowStart: string,
  mode: "5h" | "weekly" = "5h",
  peakSplit?: FiveHourWindow["peakSplit"],
  promos?: PromoPeriod[],
  planMultiplier: number = 1
): Utilization | null {
  if (!limits) return null;

  const effective = getEffectiveLimits(limits, peakStatus, windowStart, mode, peakSplit, promos);
  if (!effective) return null;

  // Scale limits by plan tier multiplier
  if (planMultiplier > 0 && planMultiplier !== 1) {
    effective.output *= planMultiplier;
    effective.inout *= planMultiplier;
    effective.total *= planMultiplier;
  }

  const normalized = normalizeUsageToBase(
    {
      output: tokens.outputTokens,
      input: tokens.inputTokens,
      cacheWrite: 0,
      cacheRead: 0,
      total: tokens.totalTokens,
    },
    peakStatus,
    windowStart,
    peakSplit,
    promos
  );

  const outputPct = (normalized.output / effective.output) * 100;
  const inoutPct =
    ((normalized.input + normalized.output) / effective.inout) * 100;
  const totalPct = (normalized.total / effective.total) * 100;

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

  return {
    outputPct: Math.round(outputPct * 10) / 10,
    inoutPct: Math.round(inoutPct * 10) / 10,
    totalPct: Math.round(totalPct * 10) / 10,
    effectivePct: Math.round(effectivePct * 10) / 10,
    bottleneck,
  };
}

/** Bottleneck short labels */
export const BOTTLENECK_LABELS: Record<Bottleneck, string> = {
  output: "OUT",
  inout: "I/O",
  total: "TOT",
};

export const BOTTLENECK_COLORS: Record<Bottleneck, string> = {
  output: "var(--accent-green)",
  inout: "var(--accent-blue)",
  total: "var(--accent-cyan)",
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
