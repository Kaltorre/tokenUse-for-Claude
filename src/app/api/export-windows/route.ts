import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { readAllUsageData } from "@/lib/reader";

export const dynamic = "force-dynamic";
import {
  buildFiveHourWindows,
  buildWeeklyBuckets,
  computeWeightedPromoMultiplier,
  DEFAULT_WEEKLY_CONFIG,
} from "@/lib/limits-analyzer";
import { CalibrationPoint, FiveHourWindow, LimitWindowType, PlanConfig, PLAN_TIERS, PromoPeriod } from "@/lib/types";
import { getEffectivePlanMultiplier, getPlanForDate } from "@/lib/plans";
import { PRICING_TABLE } from "@/lib/pricing";
import { getActivePromoMultiplier } from "@/lib/utilization";

function readPromos(): PromoPeriod[] {
  try {
    const promosPath = path.join(process.cwd(), "data", "promos.json");
    if (!fs.existsSync(promosPath)) return [];
    const raw = fs.readFileSync(promosPath, "utf-8");
    return (JSON.parse(raw) as { periods: PromoPeriod[] }).periods ?? [];
  } catch {
    return [];
  }
}

const CAL_FILE = path.join(process.cwd(), "data", "calibrations.json");
const PLANS_FILE = path.join(process.cwd(), "data", "plans.json");

function readCalibrations(): CalibrationPoint[] {
  try {
    if (!fs.existsSync(CAL_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(CAL_FILE, "utf-8")) as
      | CalibrationPoint[]
      | { calibrations?: CalibrationPoint[] };
    if (Array.isArray(raw)) return raw;
    return raw.calibrations ?? [];
  } catch {
    return [];
  }
}

function readPlans(): PlanConfig {
  try {
    if (!fs.existsSync(PLANS_FILE)) return { periods: [] };
    return JSON.parse(fs.readFileSync(PLANS_FILE, "utf-8")) as PlanConfig;
  } catch {
    return { periods: [] };
  }
}

/** Get ISO week key for grouping */
function getWeekKey(iso: string): string {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum =
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7
    );
  return `${d.getFullYear()}-W${weekNum.toString().padStart(2, "0")}`;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function describePromoSchedule(schedule: PromoPeriod["schedule"]): string {
  if (schedule.type === "all-day-all-week") return "all day, all week";
  if (schedule.type === "daily-hours") {
    return `daily ${schedule.hourFrom}:00-${schedule.hourTo}:00 ET`;
  }

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayLabel = schedule.days.map((day) => days[day]).join(", ");
  if (schedule.hourFrom == null || schedule.hourTo == null) return dayLabel;
  const mode = schedule.excludeHours ? "outside" : "during";
  return `${dayLabel} ${mode} ${schedule.hourFrom}:00-${schedule.hourTo}:00 ET`;
}

function getPlanContext(
  date: string,
  planPeriods: PlanConfig["periods"],
  windowType?: LimitWindowType
) {
  const plan = getPlanForDate(date, planPeriods);
  if (!plan) return null;

  const tier = PLAN_TIERS[plan.tier];
  // Override-aware effective multiplier for the requested window; falls back to
  // the tier default when no window type is given (plan-level header).
  const multiplier = windowType
    ? getEffectivePlanMultiplier(plan, windowType)
    : tier.multiplier;
  return {
    id: plan.id,
    tier: plan.tier,
    label: tier.label,
    shortLabel: tier.shortLabel,
    multiplierVsMax20: multiplier,
    multiplierVsPro: round(multiplier / PLAN_TIERS.pro.multiplier, 2),
    monthlyPrice: tier.monthlyPrice,
    startDate: plan.startDate,
    endDate: plan.endDate ?? null,
    note: plan.note ?? null,
  };
}

function getOverlappingPromos(
  start: string,
  end: string,
  promos: PromoPeriod[]
): PromoPeriod[] {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  return promos.filter((promo) => {
    const from = new Date(promo.dateFrom).getTime();
    const to = new Date(promo.dateTo).getTime();
    return startMs <= to && endMs >= from;
  });
}

function getWindowsInRange(
  start: string,
  end: string,
  windows: ReturnType<typeof buildFiveHourWindows>
) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  return windows.filter((window) => {
    const windowStart = new Date(window.startTime).getTime();
    const windowEnd = new Date(window.endTime).getTime();
    return windowStart < endMs && windowEnd > startMs;
  });
}

function buildPromoContext(params: {
  start: string;
  end: string;
  totalCost: number;
  totalTokens: number;
  peakStatus: "peak" | "off-peak" | "mixed";
  peakSplit?: FiveHourWindow["peakSplit"] | null;
  promos: PromoPeriod[];
  explicitMultiplier?: number;
}) {
  const {
    start,
    end,
    totalCost,
    totalTokens,
    peakStatus,
    peakSplit,
    promos,
    explicitMultiplier,
  } = params;

  const overlappingPromos = getOverlappingPromos(start, end, promos);
  const configuredMaxMultiplier = overlappingPromos.reduce(
    (max, promo) => Math.max(max, promo.multiplier),
    1
  );
  const startMultiplier =
    promos.length > 0 ? getActivePromoMultiplier(start, promos) : 1;

  let effectiveMultiplier = explicitMultiplier ?? 1;
  if (effectiveMultiplier === 1) {
    if (peakSplit && peakSplit.offPeak.totalTokens > 0) {
      effectiveMultiplier = computeWeightedPromoMultiplier(peakSplit);
    } else if (configuredMaxMultiplier !== 1 && peakStatus === "off-peak") {
      effectiveMultiplier = startMultiplier !== 1 ? startMultiplier : configuredMaxMultiplier;
    } else if (configuredMaxMultiplier !== 1 && peakStatus === "mixed") {
      effectiveMultiplier = 1 + (configuredMaxMultiplier - 1) * 0.5;
    }
  }

  const bonusApplied = effectiveMultiplier !== 1;
  const standardCost =
    peakSplit != null
      ? peakSplit.peak.totalCost
      : bonusApplied && peakStatus === "off-peak"
      ? 0
      : totalCost;
  const bonusCost =
    peakSplit != null
      ? peakSplit.offPeak.totalCost
      : bonusApplied && peakStatus === "off-peak"
      ? totalCost
      : 0;
  const standardTokens =
    peakSplit != null
      ? peakSplit.peak.totalTokens
      : bonusApplied && peakStatus === "off-peak"
      ? 0
      : totalTokens;
  const bonusTokens =
    peakSplit != null
      ? peakSplit.offPeak.totalTokens
      : bonusApplied && peakStatus === "off-peak"
      ? totalTokens
      : 0;

  return {
    peakStatus,
    configuredPromoIds: overlappingPromos.map((promo) => promo.id),
    configuredPromoNames: overlappingPromos.map((promo) => promo.name),
    configuredMaxMultiplier,
    effectiveMultiplier: round(effectiveMultiplier, 2),
    bonusApplied,
    standardSharePct:
      totalTokens > 0 ? round((standardTokens / totalTokens) * 100, 1) : 0,
    bonusSharePct:
      totalTokens > 0 ? round((bonusTokens / totalTokens) * 100, 1) : 0,
    standardUsd: round(standardCost, 2),
    bonusUsd: round(bonusCost, 2),
  };
}

const FAMILY_OUTPUT_PRICES = {
  opus: PRICING_TABLE.find((row) => row.family === "opus")!.pricing.output,
  sonnet: PRICING_TABLE.find((row) => row.family === "sonnet")!.pricing.output,
  haiku: PRICING_TABLE.find((row) => row.family === "haiku")!.pricing.output,
};

function buildUsageAnalysis(
  totalCost: number,
  planMultiplierVsMax20: number | null,
  promoMultiplier: number
) {
  const capacityMultiplier =
    planMultiplierVsMax20 != null
      ? round(planMultiplierVsMax20 * promoMultiplier, 2)
      : null;

  return {
    usageUsd: round(totalCost, 2),
    equivalentOutputMillions: {
      opus: round(totalCost / FAMILY_OUTPUT_PRICES.opus, 4),
      sonnet: round(totalCost / FAMILY_OUTPUT_PRICES.sonnet, 4),
      haiku: round(totalCost / FAMILY_OUTPUT_PRICES.haiku, 4),
    },
    normalizedUsd: {
      samePlan1x: promoMultiplier > 0 ? round(totalCost / promoMultiplier, 2) : null,
      max20_1x:
        capacityMultiplier && capacityMultiplier > 0
          ? round(totalCost / capacityMultiplier, 2)
          : null,
    },
    capacity: {
      planMultiplierVsMax20,
      promoMultiplier: round(promoMultiplier, 2),
      effectiveMultiplierVsMax20: capacityMultiplier,
    },
  };
}

function buildExportData() {
  const exportedAt = new Date().toISOString();
  const entries = readAllUsageData();
  const promos = readPromos();
  const windows = buildFiveHourWindows(entries, promos);
  const { all: weeklyAll, sonnet: weeklySonnet } = buildWeeklyBuckets(
    entries,
    DEFAULT_WEEKLY_CONFIG,
    promos
  );
  const calibrations = readCalibrations();
  const planConfig = readPlans();
  const planPeriods = planConfig.periods;
  const currentPlan = getPlanContext(exportedAt, planPeriods);

  const windowSummaries = windows.map((window) => {
    const plan = getPlanContext(window.startTime, planPeriods, "5h");
    const promo = buildPromoContext({
      start: window.startTime,
      end: window.endTime,
      totalCost: window.totalCost,
      totalTokens: window.totalTokens,
      peakStatus: window.peakStatus,
      peakSplit: window.peakSplit ?? null,
      promos,
    });

    return {
      id: window.id,
      scope: "5h" as const,
      start: window.startTime,
      end: window.endTime,
      status: window.status,
      peak: window.peakStatus,
      peakSplit: window.peakSplit ?? null,
      isoWeek: getWeekKey(window.startTime),
      plan: plan?.tier ?? null,
      planLabel: plan?.label ?? null,
      planMultiplierVsMax20: plan?.multiplierVsMax20 ?? null,
      output: window.outputTokens,
      input: window.inputTokens,
      cacheWrite: window.cacheCreationTokens,
      cacheRead: window.cacheReadTokens,
      total: window.totalTokens,
      cost: round(window.totalCost, 2),
      msgs: window.messageCount,
      sessions: window.sessionIds.length,
      models: window.models,
      promo,
      analysis: buildUsageAnalysis(
        window.totalCost,
        plan?.multiplierVsMax20 ?? null,
        promo.effectiveMultiplier
      ),
    };
  });

  const weeklyAllSummaries = weeklyAll.map((bucket) => {
    const plan = getPlanContext(bucket.weekStart, planPeriods, "weekly");
    const overlappingWindows = getWindowsInRange(bucket.weekStart, bucket.weekEnd, windows);
    const promo = buildPromoContext({
      start: bucket.weekStart,
      end: bucket.weekEnd,
      totalCost: bucket.totalCost,
      totalTokens: bucket.totalTokens,
      peakStatus: bucket.peakStatus ?? "peak",
      peakSplit: bucket.peakSplit ?? null,
      promos,
    });

    return {
      scope: "weekly-all" as const,
      week: getWeekKey(bucket.weekStart),
      start: bucket.weekStart,
      end: bucket.weekEnd,
      peak: bucket.peakStatus ?? "peak",
      peakSplit: bucket.peakSplit ?? null,
      plan: plan?.tier ?? null,
      planLabel: plan?.label ?? null,
      planMultiplierVsMax20: plan?.multiplierVsMax20 ?? null,
      output: bucket.outputTokens,
      input: bucket.inputTokens,
      cacheWrite: bucket.cacheCreationTokens,
      cacheRead: bucket.cacheReadTokens,
      total: bucket.totalTokens,
      cost: round(bucket.totalCost, 2),
      msgs: bucket.messageCount,
      windowCount: overlappingWindows.length,
      windowIds: overlappingWindows.map((window) => window.id),
      peakBreakdown: overlappingWindows.reduce(
        (acc, window) => {
          if (window.peakStatus === "off-peak") acc.offPeak += 1;
          else if (window.peakStatus === "peak") acc.peak += 1;
          else acc.mixed += 1;
          return acc;
        },
        { offPeak: 0, peak: 0, mixed: 0 }
      ),
      promo,
      analysis: buildUsageAnalysis(
        bucket.totalCost,
        plan?.multiplierVsMax20 ?? null,
        promo.effectiveMultiplier
      ),
    };
  });

  const weeklySonnetSummaries = weeklySonnet.map((bucket) => {
    const plan = getPlanContext(bucket.weekStart, planPeriods, "weekly");
    const overlappingWindows = getWindowsInRange(bucket.weekStart, bucket.weekEnd, windows);
    const promo = buildPromoContext({
      start: bucket.weekStart,
      end: bucket.weekEnd,
      totalCost: bucket.totalCost,
      totalTokens: bucket.totalTokens,
      peakStatus: bucket.peakStatus ?? "peak",
      peakSplit: bucket.peakSplit ?? null,
      promos,
    });

    return {
      scope: "weekly-sonnet" as const,
      week: getWeekKey(bucket.weekStart),
      start: bucket.weekStart,
      end: bucket.weekEnd,
      peak: bucket.peakStatus ?? "peak",
      peakSplit: bucket.peakSplit ?? null,
      plan: plan?.tier ?? null,
      planLabel: plan?.label ?? null,
      planMultiplierVsMax20: plan?.multiplierVsMax20 ?? null,
      output: bucket.outputTokens,
      input: bucket.inputTokens,
      cacheWrite: bucket.cacheCreationTokens,
      cacheRead: bucket.cacheReadTokens,
      total: bucket.totalTokens,
      cost: round(bucket.totalCost, 2),
      msgs: bucket.messageCount,
      windowCount: overlappingWindows.length,
      promo,
      analysis: buildUsageAnalysis(
        bucket.totalCost,
        plan?.multiplierVsMax20 ?? null,
        promo.effectiveMultiplier
      ),
    };
  });

  const calibrationSummaries = calibrations.map((point) => ({
    id: point.id,
    time: point.timestamp,
    reportedPct: point.reportedPct,
    scope: point.scope,
    hasTokensSnapshot: point.tokens != null,
    tokens: point.tokens ?? null,
    normalizedTokens: point.normalizedTokens ?? null,
    cost: round(point.cost, 2),
    windowId: point.windowId,
    windowStart: point.windowStart,
    peakStatus: point.peakStatus,
    anomalyFlag: point.anomalyFlag ?? null,
  }));

  const analysisRecords = [
    ...windowSummaries.map((window) => ({
      id: `5h:${window.id}`,
      kind: "bucket" as const,
      scope: window.scope,
      start: window.start,
      end: window.end,
      status: window.status,
      plan: {
        tier: window.plan,
        label: window.planLabel,
        multiplierVsMax20: window.planMultiplierVsMax20,
      },
      promo: window.promo,
      tokens: {
        output: window.output,
        input: window.input,
        cacheWrite: window.cacheWrite,
        cacheRead: window.cacheRead,
        total: window.total,
      },
      usage: window.analysis,
    })),
    ...weeklyAllSummaries.map((bucket) => ({
      id: `weekly-all:${bucket.start}`,
      kind: "bucket" as const,
      scope: bucket.scope,
      start: bucket.start,
      end: bucket.end,
      plan: {
        tier: bucket.plan,
        label: bucket.planLabel,
        multiplierVsMax20: bucket.planMultiplierVsMax20,
      },
      promo: bucket.promo,
      tokens: {
        output: bucket.output,
        input: bucket.input,
        cacheWrite: bucket.cacheWrite,
        cacheRead: bucket.cacheRead,
        total: bucket.total,
      },
      usage: bucket.analysis,
      windowCount: bucket.windowCount,
    })),
    ...weeklySonnetSummaries.map((bucket) => ({
      id: `weekly-sonnet:${bucket.start}`,
      kind: "bucket" as const,
      scope: bucket.scope,
      start: bucket.start,
      end: bucket.end,
      plan: {
        tier: bucket.plan,
        label: bucket.planLabel,
        multiplierVsMax20: bucket.planMultiplierVsMax20,
      },
      promo: bucket.promo,
      tokens: {
        output: bucket.output,
        input: bucket.input,
        cacheWrite: bucket.cacheWrite,
        cacheRead: bucket.cacheRead,
        total: bucket.total,
      },
      usage: bucket.analysis,
      windowCount: bucket.windowCount,
    })),
  ];

  return {
    exportedAt,
    exportVersion: 2,
    analysisNotes: {
      usageUsd: "Weighted usage based on per-model API pricing for input/output/cache tokens.",
      normalizedUsd:
        "samePlan1x removes promo only; max20_1x removes both promo and plan multiplier.",
    },
    plan: currentPlan?.label ?? "Max $200",
    planPeriods: planPeriods.map((period) => {
      const tier = PLAN_TIERS[period.tier];
      return {
        id: period.id,
        tier: period.tier,
        label: tier.label,
        shortLabel: tier.shortLabel,
        multiplierVsMax20: tier.multiplier,
        multiplierVsPro: round(tier.multiplier / PLAN_TIERS.pro.multiplier, 2),
        monthlyPrice: tier.monthlyPrice,
        startDate: period.startDate,
        endDate: period.endDate ?? null,
        note: period.note ?? null,
      };
    }),
    promoInfo: {
      activeAtExport: getActivePromoMultiplier(exportedAt, promos) !== 1,
      activeMultiplierAtExport: getActivePromoMultiplier(exportedAt, promos),
      periods: promos.map((promo) => ({
        id: promo.id,
        name: promo.name,
        dateFrom: promo.dateFrom,
        dateTo: promo.dateTo,
        multiplier: promo.multiplier,
        schedule: promo.schedule,
        scheduleLabel: describePromoSchedule(promo.schedule),
      })),
    },
    weeklyResetConfig: {
      allModels: {
        ...DEFAULT_WEEKLY_CONFIG.allModels,
        description: "Resets Sunday 9:00 AM (user local)",
      },
      sonnetOnly: {
        ...DEFAULT_WEEKLY_CONFIG.sonnetOnly,
        description: "Resets Monday 1:00 AM (user local)",
      },
    },
    summary: {
      totalEntries: entries.length,
      totalWindows: windows.length,
      weeklyAllBuckets: weeklyAll.length,
      weeklySonnetBuckets: weeklySonnet.length,
      calibrationPoints: calibrations.length,
      analysisRecords: analysisRecords.length,
      promoPeriods: promos.length,
    },
    calibrations: calibrationSummaries,
    windows: windowSummaries,
    weeklyAll: weeklyAllSummaries,
    weeklySonnet: weeklySonnetSummaries,
    analysisRecords,
  };
}

/**
 * GET /api/export-windows
 *
 * Exports a complete analysis-ready JSON:
 * - All 5h windows with token breakdown + peak/promo status
 * - Weekly buckets (all models + sonnet only) with reset config
 * - Calibration points with reported %
 * - Cross-reference: which 5h windows belong to which week
 *
 * This single file lets Claude analyze % vs tokens, promo effects, bottlenecks.
 */
export async function GET() {
  return NextResponse.json(buildExportData());
}

