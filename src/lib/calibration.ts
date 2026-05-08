import {
  CalibrationPoint,
  CalibrationScope,
  SolvedLimits,
  FiveHourWindow,
  WeeklyBucket,
  PeakStatus,
  PromoPeriod,
  AnomalyFlag,
  PlanPeriod,
  PlanTier,
  PLAN_TIERS,
} from "./types";
import { getActivePromoMultiplier, isInPromoRange, normalizeUsageToBase, PromoNormalizationMode } from "./utilization";
import { getPlanTierForDate } from "./plans";

const MAX20_MULTIPLIER = PLAN_TIERS.max20.multiplier;

/**
 * Scale a per-plan value (cost or token count) to the max20 baseline.
 * Calibration data is captured under whichever plan was active at that time;
 * normalising to max20 lets the solver mix points from different plans, and
 * lets `calibratedPlanLimits` (which divides by 20) project to any tier.
 *
 * Legacy points without `planTier` are assumed to already be on max20 — keeps
 * pre-tag historical data interpretable until backfill runs.
 */
function scaleToMax20(value: number, planTier: PlanTier | undefined): number {
  if (planTier == null) return value;
  const tierMult = PLAN_TIERS[planTier].multiplier;
  if (tierMult <= 0) return value;
  return value * (MAX20_MULTIPLIER / tierMult);
}

const STORAGE_KEY = "claude-usage-calibrations";

const ANOMALY_THRESHOLD = 0.30;  // 30% drop from baseline triggers flag
const LOW_QUALITY_PCT_THRESHOLD = 8;  // reportedPct below this = low quality, flag it
const ANOMALY_BASELINE_MIN_POINTS = 3;
const ANOMALY_BASELINE_WINDOW = 5;
const ANOMALY_METRICS: CalibrationPerPercentMetricKey[] = [
  "costPerPct",
  "outputPerPct",
  "ioPerPct",
  "totalPerPct",
  "inputPerPct",
  "cacheWritePerPct",
  "cacheReadPerPct",
];

export type CalibrationPerPercentMetricKey =
  | "costPerPct"
  | "outputPerPct"
  | "inputPerPct"
  | "ioPerPct"
  | "cacheWritePerPct"
  | "cacheReadPerPct"
  | "totalPerPct";

export interface CalibrationPerPercentPoint {
  id: string;
  timestamp: string;
  windowStart: string | null;
  scope: CalibrationScope;
  reportedPct: number;
  peakStatus: PeakStatus;
  anomalyStatus: AnomalyFlag["status"];
  normalizedCost: number | null;
  normalizedOutput: number | null;
  normalizedInput: number | null;
  normalizedIO: number | null;
  normalizedCacheWrite: number | null;
  normalizedCacheRead: number | null;
  normalizedTotal: number | null;
  costPerPct: number | null;
  outputPerPct: number | null;
  inputPerPct: number | null;
  ioPerPct: number | null;
  cacheWritePerPct: number | null;
  cacheReadPerPct: number | null;
  totalPerPct: number | null;
}

function medianOf(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const ANOMALY_METRIC_LABELS: Record<CalibrationPerPercentMetricKey, string> = {
  costPerPct: "cost",
  outputPerPct: "out",
  inputPerPct: "in",
  ioPerPct: "i/o",
  cacheWritePerPct: "cw",
  cacheReadPerPct: "cr",
  totalPerPct: "total",
};

interface CapacityDrop {
  metric: CalibrationPerPercentMetricKey;
  dropRatio: number;
}

interface DetectionPoint {
  analytics: CalibrationPerPercentPoint;
  original: CalibrationPoint;
  planTier: PlanTier | null;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isReviewedFlag(flag?: AnomalyFlag): boolean {
  if (!flag) return false;
  if (flag.source === "reviewed") return true;
  if (flag.source === "auto") return false;
  return flag.status === "excluded" || flag.tag != null;
}

function hasUsablePerPercentMetrics(point: CalibrationPerPercentPoint): boolean {
  return ANOMALY_METRICS.some((metric) => isFinitePositiveNumber(point[metric]));
}

function detectCapacityDrops(
  baselineHistory: CalibrationPerPercentPoint[],
  point: CalibrationPerPercentPoint
): CapacityDrop[] {
  if (baselineHistory.length < ANOMALY_BASELINE_MIN_POINTS) return [];

  const drops: CapacityDrop[] = [];

  for (const metric of ANOMALY_METRICS) {
    const currentValue = point[metric];
    if (!isFinitePositiveNumber(currentValue)) continue;

    const baselineValues = baselineHistory
      .map((entry) => entry[metric])
      .filter(isFinitePositiveNumber);

    if (baselineValues.length < ANOMALY_BASELINE_MIN_POINTS) continue;

    const baselineMedian = medianOf(baselineValues);
    if (!isFinitePositiveNumber(baselineMedian)) continue;

    const dropRatio = (baselineMedian - currentValue) / baselineMedian;
    if (dropRatio > ANOMALY_THRESHOLD) {
      drops.push({ metric, dropRatio });
    }
  }

  return drops.sort((a, b) => b.dropRatio - a.dropRatio);
}

function formatCapacityDropNote(drops: CapacityDrop[]): string {
  const details = drops
    .slice(0, 3)
    .map(
      ({ metric, dropRatio }) =>
        `${ANOMALY_METRIC_LABELS[metric]} -${Math.round(dropRatio * 100)}%`
    )
    .join(", ");

  return details
    ? `capacity drop vs baseline: ${details}`
    : "capacity drop vs baseline";
}

function formatReportedPct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function anomalyGroupKey(scope: CalibrationScope, planTier: PlanTier | null): string {
  return `${scope}::${planTier ?? "unknown"}`;
}

function getNormalizedPointUsage(point: CalibrationPoint): Required<NonNullable<CalibrationPoint["normalizedTokens"]>> | null {
  if (point.normalizedTokens) return point.normalizedTokens;
  return null;
}

export function buildPerPercentMetrics(
  points: CalibrationPoint[]
): CalibrationPerPercentPoint[] {
  return [...points]
    .sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )
    .map((point) => {
      const normalized = getNormalizedPointUsage(point);
      const pct = point.reportedPct > 0 ? point.reportedPct : null;
      const perPct = (value: number | null) =>
        value != null && pct != null ? value / pct : null;

      return {
        id: point.id,
        timestamp: point.timestamp,
        windowStart: point.windowStart,
        scope: point.scope,
        reportedPct: point.reportedPct,
        peakStatus: point.peakStatus,
        anomalyStatus: point.anomalyFlag?.status ?? "normal",
        normalizedCost: normalized?.cost ?? null,
        normalizedOutput: normalized?.output ?? null,
        normalizedInput: normalized?.input ?? null,
        normalizedIO:
          normalized != null ? normalized.input + normalized.output : null,
        normalizedCacheWrite: normalized?.cacheWrite ?? null,
        normalizedCacheRead: normalized?.cacheRead ?? null,
        normalizedTotal: normalized?.total ?? null,
        costPerPct: perPct(normalized?.cost ?? null),
        outputPerPct: perPct(normalized?.output ?? null),
        inputPerPct: perPct(normalized?.input ?? null),
        ioPerPct:
          normalized != null ? perPct(normalized.input + normalized.output) : null,
        cacheWritePerPct: perPct(normalized?.cacheWrite ?? null),
        cacheReadPerPct: perPct(normalized?.cacheRead ?? null),
        totalPerPct: perPct(normalized?.total ?? null),
      };
    });
}

// ─── CRUD ────────────────────────────────────────────────

export function loadCalibrations(): CalibrationPoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as CalibrationPoint[];
  } catch {
    return [];
  }
}

export function saveCalibrations(points: CalibrationPoint[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(points));
  } catch {}
}

export function addCalibration(point: CalibrationPoint): CalibrationPoint[] {
  const existing = loadCalibrations();
  existing.push(point);
  saveCalibrations(existing);
  return existing;
}

export function removeCalibration(id: string): CalibrationPoint[] {
  const existing = loadCalibrations().filter((p) => p.id !== id);
  saveCalibrations(existing);
  return existing;
}

/** Generate unique ID */
export function genId(): string {
  return `cal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Window Matching ─────────────────────────────────────

/** Find the 5h window closest to a given timestamp */
export function findMatchingWindow(
  timestamp: string,
  windows: FiveHourWindow[]
): FiveHourWindow | null {
  const t = new Date(timestamp).getTime();
  let best: FiveHourWindow | null = null;
  let bestDist = Infinity;

  for (const w of windows) {
    const start = new Date(w.startTime).getTime();
    const end = new Date(w.endTime).getTime();
    // Prefer windows that contain the timestamp
    if (t >= start && t <= end) return w;
    const dist = Math.min(Math.abs(t - start), Math.abs(t - end));
    if (dist < bestDist) {
      bestDist = dist;
      best = w;
    }
  }

  // Only match if within 1 hour of the window
  return bestDist < 3600000 ? best : null;
}

/** Find the weekly bucket for a given timestamp */
export function findMatchingWeek(
  timestamp: string,
  buckets: WeeklyBucket[]
): WeeklyBucket | null {
  const t = new Date(timestamp).getTime();
  for (const b of buckets) {
    const start = new Date(b.weekStart).getTime();
    const end = new Date(b.weekEnd).getTime();
    if (t >= start && t < end) return b;
  }
  return null;
}

/** Get promo multiplier for a window */
export function getPromoMultiplier(
  peakStatus: PeakStatus,
  windowStart: string,
  promos: PromoPeriod[],
  peakSplit?: FiveHourWindow["peakSplit"]
): number {
  const splitHasPromo = !!peakSplit && peakSplit.offPeak.totalTokens > 0;
  const configuredMultiplier =
    promos.length > 0
      ? getActivePromoMultiplier(windowStart, promos)
      : isInPromoRange(windowStart)
      ? 2
      : 1;
  const inPromo = splitHasPromo || configuredMultiplier !== 1;
  if (!inPromo) return 1;
  if (peakStatus === "off-peak") return configuredMultiplier !== 1 ? configuredMultiplier : 2;
  if (peakStatus === "mixed") {
    return configuredMultiplier !== 1 ? configuredMultiplier : 2;
  }
  return 1; // peak
}

// ─── Build calibration point from current data ───────────

export function buildCalibrationPoint(
  reportedPct: number,
  scope: CalibrationScope,
  window: FiveHourWindow | null,
  weekBucket: WeeklyBucket | null,
  promos: PromoPeriod[] = [],
  planPeriods: PlanPeriod[] = []
): CalibrationPoint | null {
  const source = scope === "5h" ? window : weekBucket;
  if (!source) return null;

  const peakStatus =
    scope === "5h" && window
      ? window.peakStatus
      : (weekBucket?.peakStatus ?? "peak");
  const windowStart =
    scope === "5h" && window
      ? window.startTime
      : weekBucket?.weekStart ?? new Date().toISOString();
  const normalized = normalizeUsageToBase(
    {
      output: source.outputTokens,
      input: source.inputTokens,
      cacheWrite: source.cacheCreationTokens,
      cacheRead: source.cacheReadTokens,
      total: source.totalTokens,
      cost: source.totalCost,
    },
    peakStatus,
    windowStart,
    scope === "5h" && window ? window.peakSplit : weekBucket?.peakSplit,
    promos
  );

  const planTier =
    planPeriods.length > 0
      ? getPlanTierForDate(windowStart, planPeriods) ?? undefined
      : undefined;

  return {
    id: genId(),
    timestamp: new Date().toISOString(),
    reportedPct,
    scope,
    tokens: {
      output: source.outputTokens,
      input: source.inputTokens,
      cacheWrite: source.cacheCreationTokens,
      cacheRead: source.cacheReadTokens,
      total: source.totalTokens,
    },
    normalizedTokens: normalized,
    cost: source.totalCost,
    windowId: scope === "5h" && window ? window.id : null,
    windowStart,
    peakStatus,
    planTier,
  };
}

// ─── SOLVER ──────────────────────────────────────────────

/**
 * Method 1: Direct derivation
 * For each calibration point, derive limits assuming max(out/L_o, io/L_io, tot/L_t) = pct
 * We try each dimension as the binding constraint
 */
function solveDirectMethod(points: CalibrationPoint[]): SolvedLimits["methods"][0] | null {
  if (points.length === 0) return null;

  const outputLimits: number[] = [];
  const ioLimits: number[] = [];
  const totalLimits: number[] = [];

  for (const p of points) {
    const normalized = getNormalizedPointUsage(p);
    if (!normalized) continue;
    const pct = p.reportedPct / 100;
    if (pct <= 0) continue;

    // Scale to max20 baseline so points from different plans can be mixed
    const out = scaleToMax20(normalized.output, p.planTier);
    const inp = scaleToMax20(normalized.input, p.planTier);
    const tot = scaleToMax20(normalized.total, p.planTier);

    // Each dimension could be the bottleneck
    // Base limit = normalized usage / pct
    outputLimits.push(out / pct);
    ioLimits.push((inp + out) / pct);
    totalLimits.push(tot / pct);
  }

  if (outputLimits.length === 0) return null;

  // The true limit for each dimension is the MINIMUM of the derived values
  // (because the binding constraint gives the exact limit, non-binding gives an upper bound)
  // But we use median for robustness

  // Min gives the binding constraint estimate (most accurate)
  // Median gives robustness against outliers
  const minOrMedian = (arr: number[]) =>
    arr.length <= 2 ? Math.min(...arr) : medianOf(arr);

  return {
    method: "direct",
    outputLimit: Math.round(minOrMedian(outputLimits)),
    inputOutputLimit: Math.round(minOrMedian(ioLimits)),
    totalLimit: Math.round(minOrMedian(totalLimits)),
    costLimit: 0, // not used in this method
    confidence: Math.min(points.length / 5, 1), // more points = more confidence, max at 5
    dataPoints: points.length,
  };
}

/**
 * Method 2: Cost-based estimation
 * Assumes % correlates with cost: cost / costLimit = pct
 */
function solveCostMethod(points: CalibrationPoint[]): SolvedLimits["methods"][0] | null {
  const validPoints = points.filter((p) => p.cost > 0 && p.reportedPct > 0);
  if (validPoints.length === 0) return null;

  const costLimits: number[] = [];
  for (const p of validPoints) {
    const normalized = getNormalizedPointUsage(p);
    if (!normalized) continue;
    const pct = p.reportedPct / 100;
    const scaledCost = scaleToMax20(normalized.cost, p.planTier);
    costLimits.push(scaledCost / pct);
  }

  if (costLimits.length === 0) return null;

  const costLimit = medianOf(costLimits);

  // Derive token limits from cost limit using average token/cost ratios
  // (ratios are plan-invariant since both numerator and denominator scale equally)
  let totalOutput = 0, totalIO = 0, totalAll = 0, totalCost = 0;
  for (const p of validPoints) {
    const normalized = getNormalizedPointUsage(p);
    if (!normalized) continue;
    totalOutput += normalized.output;
    totalIO += normalized.input + normalized.output;
    totalAll += normalized.total;
    totalCost += normalized.cost;
  }

  const costToOutput = totalCost > 0 ? totalOutput / totalCost : 0;
  const costToIO = totalCost > 0 ? totalIO / totalCost : 0;
  const costToAll = totalCost > 0 ? totalAll / totalCost : 0;

  return {
    method: "cost",
    outputLimit: Math.round(costLimit * costToOutput),
    inputOutputLimit: Math.round(costLimit * costToIO),
    totalLimit: Math.round(costLimit * costToAll),
    costLimit: Math.round(costLimit * 100) / 100,
    confidence: Math.min(validPoints.length / 5, 0.8), // cost method caps at 0.8 confidence
    dataPoints: validPoints.length,
  };
}

/**
 * Method 3: Weighted token estimation
 * Tries to find weights w_out, w_in, w_cw, w_cr such that:
 * w_out * out + w_in * in + w_cw * cw + w_cr * cr = effective_tokens
 * effective_tokens / limit = pct
 *
 * With enough points, solve via least squares
 */
function solveWeightedMethod(points: CalibrationPoint[]): {
  result: SolvedLimits["methods"][0];
  weights: SolvedLimits["weights"];
} | null {
  if (points.length < 2) return null;

  // Normalize: assume output weight = 1.0, solve for others
  // For each point: out + w_in * in + w_cw * cw + w_cr * cr = L * pct / multiplier
  // This is underdetermined with 1 point but gets better with more

  // Simple approach: try different weight combinations and find best fit
  // Start with pricing ratios as initial guess
  const priceRatios = {
    output: 1.0,
    input: 3 / 15,   // input/output price ratio (sonnet)
    cacheWrite: 6 / 15,  // cache1hWrite/output
    cacheRead: 0.3 / 15, // cacheRead/output
  };

  // Calculate "effective tokens" for each point using price ratios.
  // Tokens are scaled to max20 baseline so points from different plans share a frame.
  const effectiveTokens = points.map((p) => ({
    effective: (() => {
      const normalized = getNormalizedPointUsage(p);
      if (!normalized) return 0;
      const out = scaleToMax20(normalized.output, p.planTier);
      const inp = scaleToMax20(normalized.input, p.planTier);
      const cw = scaleToMax20(normalized.cacheWrite, p.planTier);
      const cr = scaleToMax20(normalized.cacheRead, p.planTier);
      return (
        out * priceRatios.output +
        inp * priceRatios.input +
        cw * priceRatios.cacheWrite +
        cr * priceRatios.cacheRead
      );
    })(),
    pct: p.reportedPct / 100,
  }));

  // Derive limit from each point
  const limits = effectiveTokens
    .filter((e) => e.pct > 0 && e.effective > 0)
    .map((e) => e.effective / e.pct);

  if (limits.length === 0) return null;

  const effectiveLimit = medianOf(limits);

  // Calculate error to assess confidence
  const errors = limits.map((l) => Math.abs(l - effectiveLimit) / effectiveLimit);
  const avgError = errors.reduce((s, e) => s + e, 0) / errors.length;
  const confidence = Math.max(0, Math.min(1, 1 - avgError * 5)) * Math.min(points.length / 4, 1);

  // Convert effective limit back to per-dimension limits
  // effective = out * 1 + in * w_in + cw * w_cw + cr * w_cr = L * pct
  // For output-only: L_out = effectiveLimit / 1.0
  // But that's not right — we need to scale
  // Actually: if only output tokens were used, L_out = effectiveLimit
  // if only input+output: L_io = effectiveLimit / avg_weight_io

  return {
    result: {
      method: "weighted",
      outputLimit: Math.round(effectiveLimit / priceRatios.output),
      inputOutputLimit: Math.round(
        effectiveLimit /
          ((priceRatios.output + priceRatios.input) / 2)
      ),
      totalLimit: Math.round(
        effectiveLimit /
          ((priceRatios.output +
            priceRatios.input +
            priceRatios.cacheWrite +
            priceRatios.cacheRead) /
            4)
      ),
      costLimit: 0,
      confidence,
      dataPoints: points.length,
    },
    weights: priceRatios,
  };
}

/**
 * Ensemble: combine all methods weighted by confidence
 */
function buildEnsemble(
  methods: SolvedLimits["methods"]
): SolvedLimits["best"] {
  if (methods.length === 0) {
    return {
      outputLimit: 0,
      inputOutputLimit: 0,
      totalLimit: 0,
      costLimit: 0,
      confidence: 0,
    };
  }

  let totalWeight = 0;
  let costWeight = 0;
  let wOutput = 0, wIO = 0, wTotal = 0, wCost = 0;

  for (const m of methods) {
    const w = m.confidence;
    totalWeight += w;
    wOutput += m.outputLimit * w;
    wIO += m.inputOutputLimit * w;
    wTotal += m.totalLimit * w;
    if (m.costLimit > 0) {
      costWeight += w;
      wCost += m.costLimit * w;
    }
  }

  if (totalWeight === 0) totalWeight = 1;

  return {
    outputLimit: Math.round(wOutput / totalWeight),
    inputOutputLimit: Math.round(wIO / totalWeight),
    totalLimit: Math.round(wTotal / totalWeight),
    costLimit: costWeight > 0 ? Math.round((wCost / costWeight) * 100) / 100 : 0,
    confidence:
      Math.round(
        (methods.reduce((s, m) => s + m.confidence, 0) / methods.length) * 100
      ) / 100,
  };
}

/**
 * Anomaly detection: compare each point against prior normalized per-1% capacity
 * for the same scope + plan, flagging only meaningful downward shifts.
 * User-reviewed overrides are preserved via anomalyFlag.source = "reviewed".
 */
export function detectAnomalies(
  points: CalibrationPoint[],
  planPeriods: PlanPeriod[] = []
): CalibrationPoint[] {
  const analyticsPoints = buildPerPercentMetrics(points);
  const originalById = new Map(points.map((point) => [point.id, point]));
  const grouped = new Map<string, DetectionPoint[]>();

  for (const analytics of analyticsPoints) {
    const original = originalById.get(analytics.id);
    if (!original) continue;

    const planTier =
      planPeriods.length > 0
        ? getPlanTierForDate(analytics.windowStart ?? analytics.timestamp, planPeriods)
        : null;
    const key = anomalyGroupKey(analytics.scope, planTier);
    const group = grouped.get(key) ?? [];
    group.push({ analytics, original, planTier });
    grouped.set(key, group);
  }

  const detectedAt = new Date().toISOString();
  const decisions = new Map<string, AnomalyFlag>();

  for (const [, group] of grouped) {
    const baselineHistory: CalibrationPerPercentPoint[] = [];

    for (const { analytics, original } of group) {
      const existingFlag = original.anomalyFlag;
      const reviewed = isReviewedFlag(existingFlag);
      const isLowQuality = analytics.reportedPct < LOW_QUALITY_PCT_THRESHOLD;
      const usableMetrics = hasUsablePerPercentMetrics(analytics);

      if (reviewed) {
        decisions.set(original.id, existingFlag!);

        if (existingFlag?.status === "normal" && usableMetrics && !isLowQuality) {
          baselineHistory.push(analytics);
        }
        continue;
      }

      const baselineWindow = baselineHistory.slice(-ANOMALY_BASELINE_WINDOW);
      const drops = detectCapacityDrops(baselineWindow, analytics);
      const hasCostDrop = drops.some((drop) => drop.metric === "costPerPct");
      const shouldFlagDrop = hasCostDrop || drops.length >= 2;

      if (isLowQuality) {
        decisions.set(original.id, {
          status: "flagged",
          source: "auto",
          detectedAt,
          note: `low reported % (${formatReportedPct(analytics.reportedPct)}%)`,
        });
        continue;
      }

      if (shouldFlagDrop) {
        decisions.set(original.id, {
          status: "flagged",
          source: "auto",
          detectedAt,
          note: formatCapacityDropNote(drops),
        });
        continue;
      }

      decisions.set(original.id, {
        status: "normal",
        source: "auto",
      });

      if (usableMetrics) {
        baselineHistory.push(analytics);
      }
    }
  }

  return points.map((point) => {
    if (isReviewedFlag(point.anomalyFlag) && point.anomalyFlag) {
      return point;
    }

    return {
      ...point,
      anomalyFlag: decisions.get(point.id) ?? {
        status: "normal",
        source: "auto",
      },
    };
  });
}

/**
 * Main solver: takes all calibration points for a given scope,
 * runs all methods, returns reconciled limits
 */
export function solveLimits(
  allPoints: CalibrationPoint[],
  scope: CalibrationScope,
  planPeriods: PlanPeriod[] = []
): SolvedLimits {
  // Filter to points that have complete data (screenshot-sourced entries may lack tokens)
  // and backfill planTier from planPeriods so the solver can scale to max20 baseline.
  const points = allPoints
    .filter(
      (p) =>
        p.scope === scope &&
        p.tokens != null &&
        p.anomalyFlag?.status !== 'excluded'
    )
    .map((p) =>
      p.planTier
        ? p
        : {
            ...p,
            planTier:
              planPeriods.length > 0
                ? getPlanTierForDate(p.windowStart ?? p.timestamp, planPeriods) ?? undefined
                : undefined,
          }
    );

  const methods: SolvedLimits["methods"] = [];
  let weights: SolvedLimits["weights"] = null;

  const direct = solveDirectMethod(points);
  if (direct) methods.push(direct);

  const cost = solveCostMethod(points);
  if (cost) methods.push(cost);

  const weighted = solveWeightedMethod(points);
  if (weighted) {
    methods.push(weighted.result);
    weights = weighted.weights;
  }

  const best = buildEnsemble(methods);

  return { methods, best, weights, scope };
}

// ─── Estimation ──────────────────────────────────────────

/**
 * Estimate % for a window using solved limits
 * Returns estimated % and which method was used
 */
export function estimateUtilization(
  tokens: {
    output: number;
    input: number;
    cacheWrite: number;
    cacheRead: number;
    total: number;
  },
  cost: number,
  solved: SolvedLimits,
  peakStatus: PeakStatus,
  windowStart: string,
  peakSplit?: FiveHourWindow["peakSplit"],
  promos: PromoPeriod[] = [],
  /** Plan tier multiplier relative to the calibration baseline (e.g. 0.25 for Max5 when calibrations are from Max20) */
  planMultiplier: number = 1,
  /** If provided, use the full same-cycle calibration series for delta-based interpolation. */
  calibrationSeries?: CalibrationPoint[],
  /** If provided, use this calibration anchor for direct interpolation instead of regression */
  calibrationAnchor?: CalibrationPoint,
  options?: { promoMode?: PromoNormalizationMode }
): {
  estimatedPct: number;
  outputPct: number;
  ioPct: number;
  totalPct: number;
  costPct: number;
  bottleneck: "output" | "inout" | "total" | "cost";
  confidence: number;
} | null {
  if (solved.best.confidence === 0) return null;

  const promoMode = options?.promoMode ?? "apply";
  const normalized = normalizeUsageToBase(
    { ...tokens, cost },
    peakStatus,
    windowStart,
    peakSplit,
    promos,
    { promoMode }
  );

  const b = solved.best;
  const pm = planMultiplier > 0 ? planMultiplier : 1;
  const fallbackOutputLimit = b.outputLimit * pm;
  const fallbackIoLimit = b.inputOutputLimit * pm;
  const fallbackTotalLimit = b.totalLimit * pm;
  const fallbackCostLimit = b.costLimit * pm;

  const pctFromLimit = (value: number, limit: number): number =>
    limit > 0 ? (value / limit) * 100 : 0;

  const buildSeriesRepresentatives = (
    points: CalibrationPoint[] | undefined
  ): Array<{
    reportedPct: number;
    timestamp: string;
    normalizedTokens: NonNullable<CalibrationPoint["normalizedTokens"]>;
  }> => {
    if (!points || points.length === 0) return [];

    const byPct = new Map<number, CalibrationPoint[]>();
    for (const point of points) {
      if (point.reportedPct <= 0 || point.normalizedTokens == null) continue;
      const group = byPct.get(point.reportedPct) ?? [];
      group.push(point);
      byPct.set(point.reportedPct, group);
    }

    return [...byPct.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([reportedPct, group]) => {
        const sortedGroup = [...group].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        const first = sortedGroup[0].normalizedTokens!;
        const last = sortedGroup[sortedGroup.length - 1].normalizedTokens!;

        return {
          reportedPct,
          timestamp: sortedGroup[sortedGroup.length - 1].timestamp,
          normalizedTokens: {
            output: (first.output + last.output) / 2,
            input: (first.input + last.input) / 2,
            cacheWrite: (first.cacheWrite + last.cacheWrite) / 2,
            cacheRead: (first.cacheRead + last.cacheRead) / 2,
            total: (first.total + last.total) / 2,
            cost: (first.cost + last.cost) / 2,
          },
        };
      });
  };

  const estimatePctFromSeries = (
    currentValue: number,
    startValue: number,
    endValue: number,
    startPct: number,
    endPct: number
  ): number | null => {
    const pctSpan = endPct - startPct;
    const valueSpan = endValue - startValue;
    if (pctSpan <= 0 || valueSpan <= 0) return null;
    const perPct = valueSpan / pctSpan;
    if (!Number.isFinite(perPct) || perPct <= 0) return null;
    return startPct + (currentValue - startValue) / perPct;
  };

  const seriesPoints = buildSeriesRepresentatives(calibrationSeries);
  if (seriesPoints.length >= 2) {
    const first = seriesPoints[0];
    const last = seriesPoints[seriesPoints.length - 1];

    const currentIO = normalized.input + normalized.output;
    const firstIO = first.normalizedTokens.input + first.normalizedTokens.output;
    const lastIO = last.normalizedTokens.input + last.normalizedTokens.output;

    const outputPct =
      estimatePctFromSeries(
        normalized.output,
        first.normalizedTokens.output,
        last.normalizedTokens.output,
        first.reportedPct,
        last.reportedPct
      ) ?? pctFromLimit(normalized.output, fallbackOutputLimit);
    const ioPct =
      estimatePctFromSeries(
        currentIO,
        firstIO,
        lastIO,
        first.reportedPct,
        last.reportedPct
      ) ?? pctFromLimit(currentIO, fallbackIoLimit);
    const totalPct =
      estimatePctFromSeries(
        normalized.total,
        first.normalizedTokens.total,
        last.normalizedTokens.total,
        first.reportedPct,
        last.reportedPct
      ) ?? pctFromLimit(normalized.total, fallbackTotalLimit);
    const costPct =
      estimatePctFromSeries(
        normalized.cost,
        first.normalizedTokens.cost,
        last.normalizedTokens.cost,
        first.reportedPct,
        last.reportedPct
      ) ?? pctFromLimit(normalized.cost, fallbackCostLimit);

    let bottleneck: "output" | "inout" | "total" | "cost" = "cost";
    let estimatedPct = costPct;

    if (outputPct > estimatedPct) { estimatedPct = outputPct; bottleneck = "output"; }
    if (ioPct > estimatedPct) { estimatedPct = ioPct; bottleneck = "inout"; }
    if (totalPct > estimatedPct) { estimatedPct = totalPct; bottleneck = "total"; }

    const pctSpan = Math.max(0, last.reportedPct - first.reportedPct);

    return {
      estimatedPct: Math.round(Math.max(estimatedPct, 0) * 10) / 10,
      outputPct: Math.round(Math.max(outputPct, 0) * 10) / 10,
      ioPct: Math.round(Math.max(ioPct, 0) * 10) / 10,
      totalPct: Math.round(Math.max(totalPct, 0) * 10) / 10,
      costPct: Math.round(Math.max(costPct, 0) * 10) / 10,
      bottleneck,
      confidence: Math.min(solved.best.confidence + Math.min(pctSpan / 100, 0.15), 1),
    };
  }

  // --- Calibration anchor: direct interpolation from known point ---
  // Much more accurate than regression for the same window period
  if (
    calibrationAnchor &&
    calibrationAnchor.reportedPct > 0 &&
    calibrationAnchor.normalizedTokens
  ) {
    const anchor = calibrationAnchor.normalizedTokens;
    if (anchor.cost > 0) {
      // Interpolate: current% = anchor% * (currentTokens / anchorTokens)
      // Use cost as the primary metric (most stable across model mixes)
      const ratio = normalized.cost / anchor.cost;
      const anchoredPct = calibrationAnchor.reportedPct * ratio;

      // Still compute per-type % for bottleneck detection using anchor-derived limits
      const effectiveLimit = anchor.cost / (calibrationAnchor.reportedPct / 100);
      const outLimitFromAnchor = anchor.output > 0
        ? (anchor.output / (calibrationAnchor.reportedPct / 100))
        : solved.best.outputLimit * (planMultiplier > 0 ? planMultiplier : 1);
      const totLimitFromAnchor = anchor.total > 0
        ? (anchor.total / (calibrationAnchor.reportedPct / 100))
        : solved.best.totalLimit * (planMultiplier > 0 ? planMultiplier : 1);

      const outputPct = outLimitFromAnchor > 0 ? (normalized.output / outLimitFromAnchor) * 100 : 0;
      const ioPct = outLimitFromAnchor > 0 ? ((normalized.input + normalized.output) / (outLimitFromAnchor * 1.5)) * 100 : 0;
      const totalPct = totLimitFromAnchor > 0 ? (normalized.total / totLimitFromAnchor) * 100 : 0;
      const costPct = effectiveLimit > 0 ? (normalized.cost / effectiveLimit) * 100 : 0;

      let bottleneck: "output" | "inout" | "total" | "cost" = "cost";
      let estimatedPct = costPct;

      if (outputPct > estimatedPct) { estimatedPct = outputPct; bottleneck = "output"; }
      if (ioPct > estimatedPct) { estimatedPct = ioPct; bottleneck = "inout"; }
      if (totalPct > estimatedPct) { estimatedPct = totalPct; bottleneck = "total"; }

      return {
        estimatedPct: Math.round(estimatedPct * 10) / 10,
        outputPct: Math.round(outputPct * 10) / 10,
        ioPct: Math.round(ioPct * 10) / 10,
        totalPct: Math.round(totalPct * 10) / 10,
        costPct: Math.round(costPct * 10) / 10,
        bottleneck,
        confidence: Math.min(solved.best.confidence + 0.2, 1), // higher confidence with anchor
      };
    }
  }

  // --- Fallback: regression-based estimation ---
  const outLimit = fallbackOutputLimit;
  const ioLimit = fallbackIoLimit;
  const totLimit = fallbackTotalLimit;
  const costLim = fallbackCostLimit;

  if (outLimit <= 0 || ioLimit <= 0 || totLimit <= 0) return null;

  const outputPct = (normalized.output / outLimit) * 100;
  const ioPct = ((normalized.input + normalized.output) / ioLimit) * 100;
  const totalPct = (normalized.total / totLimit) * 100;
  const costPct = costLim > 0 ? (normalized.cost / costLim) * 100 : 0;

  let bottleneck: "output" | "inout" | "total" | "cost" = "output";
  let estimatedPct = outputPct;

  if (ioPct > estimatedPct) {
    estimatedPct = ioPct;
    bottleneck = "inout";
  }
  if (totalPct > estimatedPct) {
    estimatedPct = totalPct;
    bottleneck = "total";
  }
  if (costPct > estimatedPct) {
    estimatedPct = costPct;
    bottleneck = "cost";
  }

  return {
    estimatedPct: Math.round(estimatedPct * 10) / 10,
    outputPct: Math.round(outputPct * 10) / 10,
    ioPct: Math.round(ioPct * 10) / 10,
    totalPct: Math.round(totalPct * 10) / 10,
    costPct: Math.round(costPct * 10) / 10,
    bottleneck,
    confidence: b.confidence,
  };
}

/**
 * Find the most recent calibration point matching a window period.
 * For weekly: matches by windowStart date (first 10 chars).
 * For 5h: matches by exact windowStart.
 */
export function findCalibrationAnchor(
  calibrations: CalibrationPoint[],
  scope: CalibrationScope,
  windowStart: string
): CalibrationPoint | undefined {
  return findCalibrationSeries(calibrations, scope, windowStart)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
}

/**
 * Return all calibration points for the same logical cycle/window.
 * Weekly keeps the legacy day-level fallback for older snapshots.
 */
export function findCalibrationSeries(
  calibrations: CalibrationPoint[],
  scope: CalibrationScope,
  windowStart: string
): CalibrationPoint[] {
  const exact = calibrations
    .filter(
      (c) =>
        c.scope === scope &&
        c.reportedPct >= 0 &&
        c.normalizedTokens != null &&
        c.windowStart === windowStart
    )
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (exact.length > 0) return exact;

  if (scope !== "5h") {
    const matchKey = windowStart.substring(0, 10);
    return calibrations
      .filter(
        (c) =>
          c.scope === scope &&
          c.reportedPct >= 0 &&
          c.normalizedTokens != null &&
          (c.windowStart ?? "").substring(0, 10) === matchKey
      )
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  return [];
}

/**
 * Check if a window has a calibration point
 */
export function getCalibrationForWindow(
  windowId: number,
  calibrations: CalibrationPoint[]
): CalibrationPoint | null {
  return calibrations.find((c) => c.windowId === windowId) ?? null;
}
