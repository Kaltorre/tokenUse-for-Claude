import {
  Bottleneck,
  CalibrationPoint,
  CalibrationScope,
  DerivedLimits,
  FiveHourWindow,
  PeakStatus,
  PromoPeriod,
  SolvedLimits,
  WeeklyBucket,
} from "./types";
import { estimateUtilization } from "./calibration";
import { calcUtilization, rangeHasPromoUsage } from "./utilization";

type UsageSnapshot = {
  outputTokens: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  peakStatus: PeakStatus;
  peakSplit?: FiveHourWindow["peakSplit"] | WeeklyBucket["peakSplit"];
  windowStart: string;
};

export interface LimitInsight {
  estimatedPct: number | null;
  noPromoPct: number | null;
  observedPct: number | null;
  deltaPct: number | null;
  bottleneck: Bottleneck | null;
  noPromoBottleneck: Bottleneck | null;
  confidence: number | null;
  observedAt: string | null;
  promoActive: boolean;
}

interface Params {
  scope: CalibrationScope;
  usage: UsageSnapshot;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  promos?: PromoPeriod[];
  planMultiplier?: number;
  calibrationSeries?: CalibrationPoint[];
  calibrationAnchor?: CalibrationPoint;
  observedPoint?: CalibrationPoint | null;
}

function roundPct(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10;
}

export function computeLimitInsight({
  scope,
  usage,
  solvedLimits,
  derivedLimits,
  promos = [],
  planMultiplier = 1,
  calibrationSeries,
  calibrationAnchor,
  observedPoint,
}: Params): LimitInsight {
  const solved = solvedLimits?.[scope];

  let estimatedPct: number | null = null;
  let noPromoPct: number | null = null;
  let bottleneck: Bottleneck | null = null;
  let noPromoBottleneck: Bottleneck | null = null;
  let confidence: number | null = null;

  if (solved && solved.best.confidence > 0) {
    const estimated = estimateUtilization(
      {
        output: usage.outputTokens,
        input: usage.inputTokens,
        cacheWrite: usage.cacheCreationTokens,
        cacheRead: usage.cacheReadTokens,
        total: usage.totalTokens,
      },
      usage.totalCost,
      solved,
      usage.peakStatus,
      usage.windowStart,
      usage.peakSplit,
      promos,
      planMultiplier,
      calibrationSeries,
      calibrationAnchor
    );
    const noPromo = estimateUtilization(
      {
        output: usage.outputTokens,
        input: usage.inputTokens,
        cacheWrite: usage.cacheCreationTokens,
        cacheRead: usage.cacheReadTokens,
        total: usage.totalTokens,
      },
      usage.totalCost,
      solved,
      usage.peakStatus,
      usage.windowStart,
      usage.peakSplit,
      promos,
      planMultiplier,
      calibrationSeries,
      undefined,
      { promoMode: "ignore" }
    );

    estimatedPct = estimated?.estimatedPct ?? null;
    noPromoPct = noPromo?.estimatedPct ?? estimatedPct;
    bottleneck = estimated?.bottleneck ?? null;
    noPromoBottleneck = noPromo?.bottleneck ?? bottleneck;
    confidence = estimated?.confidence ?? noPromo?.confidence ?? solved.best.confidence;
  } else if (derivedLimits) {
    const estimated = calcUtilization(
      {
        outputTokens: usage.outputTokens,
        inputTokens: usage.inputTokens,
        totalTokens: usage.totalTokens,
        totalCost: usage.totalCost,
      },
      derivedLimits,
      usage.peakStatus,
      usage.windowStart,
      scope === "5h" ? "5h" : "weekly",
      usage.peakSplit,
      promos,
      planMultiplier
    );
    const noPromo = calcUtilization(
      {
        outputTokens: usage.outputTokens,
        inputTokens: usage.inputTokens,
        totalTokens: usage.totalTokens,
        totalCost: usage.totalCost,
      },
      derivedLimits,
      usage.peakStatus,
      usage.windowStart,
      scope === "5h" ? "5h" : "weekly",
      usage.peakSplit,
      promos,
      planMultiplier,
      { promoMode: "ignore" }
    );

    estimatedPct = estimated?.effectivePct ?? null;
    noPromoPct = noPromo?.effectivePct ?? estimatedPct;
    bottleneck = estimated?.bottleneck ?? null;
    noPromoBottleneck = noPromo?.bottleneck ?? bottleneck;
  }

  const observedPct = observedPoint?.reportedPct ?? null;
  const deltaPct =
    observedPct != null && estimatedPct != null ? roundPct(observedPct - estimatedPct) : null;
  const promoAffectsThisBucket = rangeHasPromoUsage(
    usage.peakStatus,
    usage.windowStart,
    usage.peakSplit,
    promos
  );
  const promoActive =
    promoAffectsThisBucket &&
    estimatedPct != null &&
    noPromoPct != null &&
    noPromoPct - estimatedPct > 0.05;

  return {
    estimatedPct: roundPct(estimatedPct),
    noPromoPct: promoActive ? roundPct(noPromoPct) : null,
    observedPct: roundPct(observedPct),
    deltaPct,
    bottleneck,
    noPromoBottleneck,
    confidence: confidence == null ? null : Math.round(confidence * 100) / 100,
    observedAt: observedPoint?.timestamp ?? null,
    promoActive,
  };
}
