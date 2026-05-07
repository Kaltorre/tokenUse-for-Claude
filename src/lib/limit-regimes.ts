import {
  CalibrationPoint,
  CalibrationScope,
  DEFAULT_LIMITS_5H,
  DEFAULT_LIMITS_WEEKLY,
  LimitWindowType,
  PLAN_TIERS,
  PlanPeriod,
  PlanTier,
} from "./types";

export interface LimitRegime {
  id: string;
  label: string;
  tier: PlanTier;
  tierLabel: string;
  startDate: string;
  endDate: string | null;
  theoreticalMultiplier: number;
  theoreticalMultipliers: Partial<Record<LimitWindowType, number>>;
  note?: string;
}

export interface LimitRegimeResolution {
  status: "matched" | "unassigned" | "ambiguous";
  regime: LimitRegime | null;
  candidates: LimitRegime[];
}

export interface CostProxyUsageSnapshot {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
  costProxy: number;
  source: "normalized" | "raw";
}

export interface UtilizationResidual {
  observedPct: number | null;
  estimatedPct: number | null;
  deltaPct: number | null;
  absDeltaPct: number | null;
  status: "missing-observed" | "missing-estimate" | "close" | "watch" | "suspicious";
}

export interface InferredLimitPoint {
  id: string;
  timestamp: string;
  scope: CalibrationScope;
  windowType: LimitWindowType;
  windowStart: string | null;
  regime: LimitRegime | null;
  regimeStatus: LimitRegimeResolution["status"];
  observedPct: number;
  costProxy: number;
  costProxyPerPct: number;
  effectiveCostProxyLimit: number;
  theoreticalMultiplier: number | null;
  inferredMultiplier: number | null;
  theoryMatchRatio: number | null;
}

export interface LimitRegimeEvidenceRow {
  key: string;
  windowType: LimitWindowType;
  scope: CalibrationScope;
  regime: LimitRegime | null;
  regimeStatus: LimitRegimeResolution["status"];
  calibrationCount: number;
  latestTimestamp: string | null;
  latestObservedPct: number | null;
  costProxyPerPct: number | null;
  effectiveCostProxyLimit: number | null;
  theoreticalMultiplier: number | null;
  theoreticalCostProxyLimit: number | null;
  inferredMultiplier: number | null;
  theoryMatchRatio: number | null;
  latestResidual: UtilizationResidual;
  points: InferredLimitPoint[];
}

function timestampMs(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function periodMatches(timestamp: string, period: PlanPeriod): boolean {
  const t = timestampMs(timestamp);
  const start = timestampMs(period.startDate);
  const end = period.endDate ? timestampMs(period.endDate) : Infinity;
  if (!Number.isFinite(t) || !Number.isFinite(start)) return false;
  return t >= start && t <= end;
}

export function calibrationScopeToWindowType(scope: CalibrationScope): LimitWindowType {
  return scope === "5h" ? "5h" : "weekly";
}

export function getWindowTheoreticalMultiplier(
  period: PlanPeriod,
  windowType: LimitWindowType
): number {
  const tierDefault = PLAN_TIERS[period.tier]?.multiplier ?? 1;
  return (
    period.theoreticalMultipliers?.[windowType] ??
    period.theoreticalMultiplier ??
    tierDefault
  );
}

export function getTheoreticalCostProxyLimit(
  multiplier: number | null,
  windowType: LimitWindowType
): number | null {
  if (multiplier == null || multiplier <= 0) return null;
  const proBase =
    windowType === "5h"
      ? DEFAULT_LIMITS_5H.costLimit
      : DEFAULT_LIMITS_WEEKLY.costLimit;
  return round(proBase * multiplier, 2);
}

export function planPeriodToRegime(period: PlanPeriod): LimitRegime {
  const tier = PLAN_TIERS[period.tier];
  return {
    id: period.id,
    label: period.displayName ?? tier?.label ?? period.tier,
    tier: period.tier,
    tierLabel: tier?.label ?? period.tier,
    startDate: period.startDate,
    endDate: period.endDate,
    theoreticalMultiplier: period.theoreticalMultiplier ?? tier?.multiplier ?? 1,
    theoreticalMultipliers: period.theoreticalMultipliers ?? {},
    note: period.note,
  };
}

export function resolveLimitRegime(
  timestamp: string,
  periods: PlanPeriod[]
): LimitRegimeResolution {
  const candidates = periods
    .filter((period) => periodMatches(timestamp, period))
    .map(planPeriodToRegime)
    .sort((a, b) => timestampMs(b.startDate) - timestampMs(a.startDate));

  if (candidates.length === 0) {
    return { status: "unassigned", regime: null, candidates: [] };
  }

  if (candidates.length > 1) {
    return { status: "ambiguous", regime: null, candidates };
  }

  return { status: "matched", regime: candidates[0], candidates };
}

export function getCalibrationCostProxy(point: CalibrationPoint): CostProxyUsageSnapshot | null {
  if (point.normalizedTokens) {
    return {
      input: point.normalizedTokens.input,
      output: point.normalizedTokens.output,
      cacheWrite: point.normalizedTokens.cacheWrite,
      cacheRead: point.normalizedTokens.cacheRead,
      total: point.normalizedTokens.total,
      costProxy: point.normalizedTokens.cost,
      source: "normalized",
    };
  }

  if (!point.tokens || point.cost <= 0) return null;
  return {
    input: point.tokens.input,
    output: point.tokens.output,
    cacheWrite: point.tokens.cacheWrite,
    cacheRead: point.tokens.cacheRead,
    total: point.tokens.total,
    costProxy: point.cost,
    source: "raw",
  };
}

export function estimatePctFromCostProxy(
  costProxy: number | null | undefined,
  effectiveCostProxyLimit: number | null | undefined
): number | null {
  if (
    costProxy == null ||
    effectiveCostProxyLimit == null ||
    !Number.isFinite(costProxy) ||
    !Number.isFinite(effectiveCostProxyLimit) ||
    effectiveCostProxyLimit <= 0
  ) {
    return null;
  }
  return round((costProxy / effectiveCostProxyLimit) * 100, 1);
}

export function buildUtilizationResidual(
  observedPct: number | null | undefined,
  estimatedPct: number | null | undefined
): UtilizationResidual {
  if (observedPct == null || !Number.isFinite(observedPct)) {
    return {
      observedPct: null,
      estimatedPct: estimatedPct ?? null,
      deltaPct: null,
      absDeltaPct: null,
      status: "missing-observed",
    };
  }

  if (estimatedPct == null || !Number.isFinite(estimatedPct)) {
    return {
      observedPct,
      estimatedPct: null,
      deltaPct: null,
      absDeltaPct: null,
      status: "missing-estimate",
    };
  }

  const deltaPct = round(observedPct - estimatedPct, 1);
  const absDeltaPct = Math.abs(deltaPct);
  const status =
    absDeltaPct <= 5
      ? "close"
      : absDeltaPct <= 12
      ? "watch"
      : "suspicious";

  return {
    observedPct,
    estimatedPct,
    deltaPct,
    absDeltaPct,
    status,
  };
}

export function deriveInferredLimitPoint(
  point: CalibrationPoint,
  periods: PlanPeriod[]
): InferredLimitPoint | null {
  if (point.reportedPct <= 0) return null;

  const usage = getCalibrationCostProxy(point);
  if (!usage || usage.costProxy <= 0) return null;

  const windowType = calibrationScopeToWindowType(point.scope);
  const timestamp = point.windowStart ?? point.timestamp;
  const resolution = resolveLimitRegime(timestamp, periods);
  const theoreticalMultiplier = resolution.regime
    ? getWindowTheoreticalMultiplier(resolution.regime, windowType)
    : point.planTier
    ? PLAN_TIERS[point.planTier]?.multiplier ?? null
    : null;
  const proBase =
    windowType === "5h"
      ? DEFAULT_LIMITS_5H.costLimit
      : DEFAULT_LIMITS_WEEKLY.costLimit;
  const costProxyPerPct = usage.costProxy / point.reportedPct;
  const effectiveCostProxyLimit = costProxyPerPct * 100;
  const inferredMultiplier = proBase > 0 ? effectiveCostProxyLimit / proBase : null;
  const theoryMatchRatio =
    inferredMultiplier != null && theoreticalMultiplier != null && theoreticalMultiplier > 0
      ? inferredMultiplier / theoreticalMultiplier
      : null;

  return {
    id: point.id,
    timestamp: point.timestamp,
    scope: point.scope,
    windowType,
    windowStart: point.windowStart,
    regime: resolution.regime,
    regimeStatus: resolution.status,
    observedPct: point.reportedPct,
    costProxy: round(usage.costProxy, 4),
    costProxyPerPct: round(costProxyPerPct, 4),
    effectiveCostProxyLimit: round(effectiveCostProxyLimit, 4),
    theoreticalMultiplier:
      theoreticalMultiplier == null ? null : round(theoreticalMultiplier, 4),
    inferredMultiplier:
      inferredMultiplier == null ? null : round(inferredMultiplier, 4),
    theoryMatchRatio:
      theoryMatchRatio == null ? null : round(theoryMatchRatio, 4),
  };
}

export function buildLimitRegimeEvidence(
  points: CalibrationPoint[],
  periods: PlanPeriod[]
): LimitRegimeEvidenceRow[] {
  const inferred = points
    .filter((point) => point.anomalyFlag?.status !== "excluded")
    .map((point) => deriveInferredLimitPoint(point, periods))
    .filter((point): point is InferredLimitPoint => point != null);

  const groups = new Map<string, InferredLimitPoint[]>();

  for (const point of inferred) {
    const regimeKey =
      point.regime?.id ??
      (point.regimeStatus === "ambiguous"
        ? "ambiguous"
        : point.theoreticalMultiplier != null
        ? `legacy-${point.theoreticalMultiplier}`
        : "unassigned");
    const key = `${regimeKey}:${point.scope}`;
    const group = groups.get(key) ?? [];
    group.push(point);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const sorted = [...group].sort(
        (a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp)
      );
      const latest = sorted[sorted.length - 1] ?? null;
      const costProxyPerPct = median(group.map((point) => point.costProxyPerPct));
      const effectiveCostProxyLimit =
        costProxyPerPct == null ? null : round(costProxyPerPct * 100, 4);
      const theoreticalMultiplier =
        latest?.theoreticalMultiplier ??
        median(group.map((point) => point.theoreticalMultiplier ?? NaN));
      const inferredMultiplier =
        latest?.windowType && effectiveCostProxyLimit != null
          ? round(
              effectiveCostProxyLimit /
                (latest.windowType === "5h"
                  ? DEFAULT_LIMITS_5H.costLimit
                  : DEFAULT_LIMITS_WEEKLY.costLimit),
              4
            )
          : null;
      const theoryMatchRatio =
        inferredMultiplier != null &&
        theoreticalMultiplier != null &&
        theoreticalMultiplier > 0
          ? round(inferredMultiplier / theoreticalMultiplier, 4)
          : null;
      const latestEstimate = latest
        ? estimatePctFromCostProxy(latest.costProxy, effectiveCostProxyLimit)
        : null;

      return {
        key,
        windowType: latest?.windowType ?? "5h",
        scope: latest?.scope ?? "5h",
        regime: latest?.regime ?? null,
        regimeStatus: latest?.regimeStatus ?? "unassigned",
        calibrationCount: group.length,
        latestTimestamp: latest?.timestamp ?? null,
        latestObservedPct: latest?.observedPct ?? null,
        costProxyPerPct: costProxyPerPct == null ? null : round(costProxyPerPct, 4),
        effectiveCostProxyLimit,
        theoreticalMultiplier:
          theoreticalMultiplier == null ? null : round(theoreticalMultiplier, 4),
        theoreticalCostProxyLimit: getTheoreticalCostProxyLimit(
          theoreticalMultiplier,
          latest?.windowType ?? "5h"
        ),
        inferredMultiplier,
        theoryMatchRatio,
        latestResidual: buildUtilizationResidual(latest?.observedPct, latestEstimate),
        points: sorted,
      } satisfies LimitRegimeEvidenceRow;
    })
    .sort((a, b) => {
      const aTime = a.latestTimestamp ? timestampMs(a.latestTimestamp) : 0;
      const bTime = b.latestTimestamp ? timestampMs(b.latestTimestamp) : 0;
      return bTime - aTime;
    });
}
