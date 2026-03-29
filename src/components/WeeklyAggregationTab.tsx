"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  WeeklyBucket,
  FiveHourWindow,
  DerivedLimits,
  SolvedLimits,
  CalibrationScope,
  PlanPeriod,
  PLAN_TIERS,
  PromoPeriod,
  DEFAULT_LIMITS_5H,
  DEFAULT_LIMITS_WEEKLY,
} from "@/lib/types";
import { formatTokens, formatCost } from "@/lib/format";
import { getPlanTierForDate } from "@/lib/plans";
import { calcUtilization } from "@/lib/utilization";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
  LineChart,
  Line,
  Legend,
  ReferenceArea,
} from "recharts";

interface Props {
  weeklyAll: WeeklyBucket[];
  weeklySonnet: WeeklyBucket[];
  windows: FiveHourWindow[];
  derivedLimits: DerivedLimits | null;
  solvedLimits?: Record<CalibrationScope, SolvedLimits>;
  planPeriods?: PlanPeriod[];
  promoPeriods?: PromoPeriod[];
}

type PeriodTab = "week" | "5h";
type ModelScope = "all" | "sonnet";

interface AggregatedWeekRow {
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  dateRange: string;
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  baseTotalTokens: number;
  baseCost: number;
  baseInputTokens: number;
  baseOutputTokens: number;
  baseCacheCreationTokens: number;
  baseCacheReadTokens: number;
  outputPct: number;
  inoutPct: number;
  totalPct: number;
  effectivePct: number;
  rawCostPer1Pct: number;
  normalizedCostPer1Pct: number;
  tokensPer1Pct: number;
  inputPer1Pct: number;
  outputPer1Pct: number;
  cacheCreationPer1Pct: number;
  cacheReadPer1Pct: number;
  sessions5h: number | null;
  messageCount: number;
  planTier: PlanPeriod["tier"] | null;
  planLabel: string;
  planShortLabel: string;
  planColor: string;
}

interface FiveHourAverageRow {
  weekStart: string;
  dateRange: string;
  planLabel: string;
  planShortLabel: string;
  planColor: string;
  windowCount: number;
  avgPct: number | null;
  avgCost: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCacheCreationTokens: number;
  avgCacheReadTokens: number;
  avgTotalTokens: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
}

const WEEKLY_CHART_CAP_PCT = 300;
const WINDOWS_PAGE_SIZE = 100;
const EMPTY_PLAN_PERIODS: PlanPeriod[] = [];
const EMPTY_PROMO_PERIODS: PromoPeriod[] = [];

function getWeekLabel(iso: string): string {
  const d = new Date(iso);
  const weekNum = getWeekNumber(d);
  return `W${weekNum}`;
}

function getWeekNumber(d: Date): number {
  const firstDayOfYear = new Date(d.getFullYear(), 0, 1);
  const pastDaysOfYear = (d.getTime() - firstDayOfYear.getTime()) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const fmt = (d: Date) =>
    d.toLocaleDateString("pl-PL", { day: "2-digit", month: "short" });
  return `${fmt(s)} - ${fmt(e)}`;
}

function buildScaledLimits(
  derivedLimits: DerivedLimits | null,
  planScale: number
): DerivedLimits {
  const base = derivedLimits ?? {
    outputLimit: DEFAULT_LIMITS_5H.outputLimit,
    inputOutputLimit: DEFAULT_LIMITS_5H.inputOutputLimit,
    totalLimit: DEFAULT_LIMITS_5H.totalLimit,
    costLimit: DEFAULT_LIMITS_5H.costLimit,
    weeklyOutputLimit: DEFAULT_LIMITS_WEEKLY.outputLimit,
    weeklyInputOutputLimit: DEFAULT_LIMITS_WEEKLY.inputOutputLimit,
    weeklyTotalLimit: DEFAULT_LIMITS_WEEKLY.totalLimit,
    weeklyCostLimit: DEFAULT_LIMITS_WEEKLY.costLimit,
    calibratedAt: "",
    calibrationPct: 0,
    promoActive: false,
  };

  return {
    ...base,
    outputLimit: base.outputLimit * planScale,
    inputOutputLimit: base.inputOutputLimit * planScale,
    totalLimit: base.totalLimit * planScale,
    costLimit: base.costLimit * planScale,
    weeklyOutputLimit:
      base.weeklyOutputLimit != null ? base.weeklyOutputLimit * planScale : null,
    weeklyInputOutputLimit:
      base.weeklyInputOutputLimit != null
        ? base.weeklyInputOutputLimit * planScale
        : null,
    weeklyTotalLimit:
      base.weeklyTotalLimit != null ? base.weeklyTotalLimit * planScale : null,
    weeklyCostLimit:
      base.weeklyCostLimit != null ? base.weeklyCostLimit * planScale : null,
  };
}

function ScopeTabs({
  value,
  onChange,
}: {
  value: ModelScope;
  onChange: (value: ModelScope) => void;
}) {
  return (
    <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5">
      {([
        ["all", "ALL"],
        ["sonnet", "SONNET"],
      ] as const).map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-2.5 py-1 rounded text-[10px] font-medium transition-all ${
            value === key
              ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function PaginationControls({
  page,
  pageCount,
  pageStart,
  pageEnd,
  totalItems,
  itemLabel,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  pageStart: number;
  pageEnd: number;
  totalItems: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
}) {
  const buttonClass =
    "px-2 py-1 rounded border border-[var(--border-subtle)] text-[10px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--bg-secondary)]";

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <div className="text-[11px] text-[var(--text-muted)]">
        {totalItems === 0
          ? `Brak ${itemLabel}.`
          : `${pageStart}-${pageEnd} z ${totalItems} ${itemLabel}`}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={buttonClass}
          onClick={() => onPageChange(1)}
          disabled={page <= 1}
        >
          First
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          Prev
        </button>
        <span className="min-w-16 text-center text-[11px] text-[var(--text-secondary)] tabular-nums">
          {page}/{pageCount}
        </span>
        <button
          type="button"
          className={buttonClass}
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
        >
          Next
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => onPageChange(pageCount)}
          disabled={page >= pageCount}
        >
          Last
        </button>
      </div>
    </div>
  );
}

interface Per1TrendPoint {
  name: string;
  fullLabel: string;
  rawCostPer1Pct: number;
  normalizedCostPer1Pct: number;
  tokensPer1Pct: number;
  planColor: string;
  planShortLabel: string;
  planLabel: string;
}

interface TrendDotProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: Per1TrendPoint;
}

function Per1TrendChart({
  title,
  description,
  data,
  headerExtra,
}: {
  title: string;
  description: string;
  data: Per1TrendPoint[];
  headerExtra?: React.ReactNode;
}) {
  // Resolve CSS variables → hex for SVG attributes (CSS vars don't work in SVG fill/stroke)
  const [svgColorMap, setSvgColorMap] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const map: Record<string, string> = {};
    const vars = new Set<string>();
    for (const p of data) {
      if (p.planColor.startsWith("var(")) vars.add(p.planColor);
    }
    for (const v of vars) {
      const match = v.match(/^var\((.+)\)$/);
      if (match) {
        const resolved = style.getPropertyValue(match[1]).trim();
        if (resolved) map[v] = resolved;
      }
    }
    setSvgColorMap(map);
  }, [data]);

  const svgColor = useCallback(
    (color: string) => svgColorMap[color] || color,
    [svgColorMap]
  );

  if (data.length === 0) {
    return (
      <div className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-[var(--text-secondary)]">{title}</h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">{description}</p>
          </div>
          {headerExtra}
        </div>
        <p className="text-sm text-[var(--text-muted)] mt-4">Brak danych trendu.</p>
      </div>
    );
  }

  const planSegments = data.reduce<
    Array<{
      startName: string;
      endName: string;
      planColor: string;
      planShortLabel: string;
      planLabel: string;
    }>
  >((segments, point) => {
    const last = segments[segments.length - 1];
    if (
      last &&
      last.planColor === point.planColor &&
      last.planShortLabel === point.planShortLabel
    ) {
      last.endName = point.name;
      return segments;
    }

    segments.push({
      startName: point.name,
      endName: point.name,
      planColor: point.planColor,
      planShortLabel: point.planShortLabel,
      planLabel: point.planLabel,
    });
    return segments;
  }, []);

  const visiblePlans = Array.from(
    new Map(
      data.map((point) => [
        point.planShortLabel,
        {
          planColor: point.planColor,
          planShortLabel: point.planShortLabel,
          planLabel: point.planLabel,
        },
      ])
    ).values()
  );

  const xInterval =
    data.length > 80 ? Math.floor(data.length / 15) :
    data.length > 40 ? Math.floor(data.length / 12) :
    data.length > 20 ? Math.floor(data.length / 10) : 0;

  const makeDot = (lineStroke: string) => (props: unknown) => {
    const dot = props as TrendDotProps;
    if (dot.cx == null || dot.cy == null || !dot.payload) {
      return <circle key={`dot-${dot.index}`} cx={0} cy={0} r={0} fill="transparent" />;
    }
    return (
      <circle
        key={`dot-${dot.index}`}
        cx={dot.cx}
        cy={dot.cy}
        r={2.5}
        fill={svgColor(dot.payload.planColor)}
        stroke={lineStroke}
        strokeWidth={1.5}
      />
    );
  };

  const makeActiveDot = (lineStroke: string) => (props: unknown) => {
    const dot = props as TrendDotProps;
    if (dot.cx == null || dot.cy == null || !dot.payload) {
      return <circle key={`active-${dot.index}`} cx={0} cy={0} r={0} fill="transparent" />;
    }
    return (
      <circle
        key={`active-${dot.index}`}
        cx={dot.cx}
        cy={dot.cy}
        r={4}
        fill={svgColor(dot.payload.planColor)}
        stroke={lineStroke}
        strokeWidth={2}
      />
    );
  };

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">{title}</h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">{description}</p>
        </div>
        {headerExtra}
      </div>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            {planSegments.map((segment, idx) => (
              <ReferenceArea
                key={`${segment.startName}-${segment.endName}-${segment.planShortLabel}`}
                x1={segment.startName}
                x2={segment.endName}
                fill={svgColor(segment.planColor)}
                fillOpacity={0.16}
                stroke={svgColor(segment.planColor)}
                strokeOpacity={idx > 0 ? 0.5 : 0}
                strokeWidth={idx > 0 ? 1.5 : 0}
              />
            ))}
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border-subtle)"
              vertical={false}
            />
            <XAxis
              dataKey="name"
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              axisLine={{ stroke: "var(--border-subtle)" }}
              tickLine={false}
              interval={xInterval}
            />
            <YAxis
              yAxisId="cost"
              tickFormatter={(v) => `$${Math.round(Number(v))}`}
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <YAxis
              yAxisId="tokens"
              orientation="right"
              tickFormatter={(v) => formatTokens(Number(v))}
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={58}
            />
            <Tooltip
              contentStyle={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(_label, payload) =>
                (payload?.[0]?.payload as Per1TrendPoint | undefined)?.fullLabel ?? _label
              }
              formatter={(value: number | string, name: string) => {
                const numeric = typeof value === "number" ? value : Number(value);
                return String(name).includes("$")
                  ? [formatCost(numeric), name]
                  : [formatTokens(numeric), name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="normalizedCostPer1Pct"
              name="Norm $/1%"
              stroke="var(--accent-green)"
              strokeWidth={2}
              dot={makeDot("var(--accent-green)")}
              activeDot={makeActiveDot("var(--accent-green)")}
            />
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="rawCostPer1Pct"
              name="Raw $/1%"
              stroke="var(--accent-orange)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              activeDot={makeActiveDot("var(--accent-orange)")}
            />
            <Line
              yAxisId="tokens"
              type="monotone"
              dataKey="tokensPer1Pct"
              name="Base Tot/1%"
              stroke="var(--accent-blue)"
              strokeWidth={2}
              dot={false}
              activeDot={makeActiveDot("var(--accent-blue)")}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {visiblePlans.length > 0 && (
        <div className="flex items-center gap-1.5 mt-3">
          <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider mr-1">Plan:</span>
          {visiblePlans.map((plan) => (
            <span
              key={plan.planShortLabel}
              className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-medium"
              style={{
                color: plan.planColor,
                background: `color-mix(in srgb, ${plan.planColor} 18%, transparent)`,
                borderLeft: `3px solid`,
                borderColor: plan.planColor,
              }}
            >
              {plan.planShortLabel} · {plan.planLabel}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function WeeklyAggregationTab({
  weeklyAll,
  weeklySonnet,
  windows,
  derivedLimits,
  solvedLimits,
  planPeriods = EMPTY_PLAN_PERIODS,
  promoPeriods = EMPTY_PROMO_PERIODS,
}: Props) {
  const [period, setPeriod] = useState<PeriodTab>("week");
  const [scope, setScope] = useState<ModelScope>("all");
  const [windowPage, setWindowPage] = useState(1);
  const [trendScope5h, setTrendScope5h] = useState<"page" | "all" | "daily" | "weekly">("all");

  // Build effective limits: prefer solver weekly limits, fall back to derivedLimits
  const effectiveLimits = useMemo((): DerivedLimits | null => {
    const weeklyAll = solvedLimits?.["weekly-all"];
    const fiveH = solvedLimits?.["5h"];

    const base = derivedLimits ?? {
      outputLimit: DEFAULT_LIMITS_5H.outputLimit,
      inputOutputLimit: DEFAULT_LIMITS_5H.inputOutputLimit,
      totalLimit: DEFAULT_LIMITS_5H.totalLimit,
      costLimit: DEFAULT_LIMITS_5H.costLimit,
      weeklyOutputLimit: DEFAULT_LIMITS_WEEKLY.outputLimit,
      weeklyInputOutputLimit: DEFAULT_LIMITS_WEEKLY.inputOutputLimit,
      weeklyTotalLimit: DEFAULT_LIMITS_WEEKLY.totalLimit,
      weeklyCostLimit: DEFAULT_LIMITS_WEEKLY.costLimit,
      calibratedAt: "",
      calibrationPct: 0,
      promoActive: false,
    };

    return {
      ...base,
      outputLimit:
        fiveH && fiveH.best.confidence > 0 && fiveH.best.outputLimit > 0
          ? fiveH.best.outputLimit
          : base.outputLimit > 0
          ? base.outputLimit
          : DEFAULT_LIMITS_5H.outputLimit,
      inputOutputLimit:
        fiveH && fiveH.best.confidence > 0 && fiveH.best.inputOutputLimit > 0
          ? fiveH.best.inputOutputLimit
          : base.inputOutputLimit > 0
          ? base.inputOutputLimit
          : DEFAULT_LIMITS_5H.inputOutputLimit,
      totalLimit:
        fiveH && fiveH.best.confidence > 0 && fiveH.best.totalLimit > 0
          ? fiveH.best.totalLimit
          : base.totalLimit > 0
          ? base.totalLimit
          : DEFAULT_LIMITS_5H.totalLimit,
      costLimit:
        fiveH && fiveH.best.confidence > 0 && fiveH.best.costLimit > 0
          ? fiveH.best.costLimit
          : base.costLimit > 0
          ? base.costLimit
          : DEFAULT_LIMITS_5H.costLimit,
      weeklyOutputLimit:
        weeklyAll && weeklyAll.best.confidence > 0 && weeklyAll.best.outputLimit > 0
          ? weeklyAll.best.outputLimit
          : base.weeklyOutputLimit ?? DEFAULT_LIMITS_WEEKLY.outputLimit,
      weeklyInputOutputLimit:
        weeklyAll && weeklyAll.best.confidence > 0 && weeklyAll.best.inputOutputLimit > 0
          ? weeklyAll.best.inputOutputLimit
          : base.weeklyInputOutputLimit ?? DEFAULT_LIMITS_WEEKLY.inputOutputLimit,
      weeklyTotalLimit:
        weeklyAll && weeklyAll.best.confidence > 0 && weeklyAll.best.totalLimit > 0
          ? weeklyAll.best.totalLimit
          : base.weeklyTotalLimit ?? DEFAULT_LIMITS_WEEKLY.totalLimit,
      weeklyCostLimit:
        weeklyAll && weeklyAll.best.confidence > 0 && weeklyAll.best.costLimit > 0
          ? weeklyAll.best.costLimit
          : base.weeklyCostLimit ?? DEFAULT_LIMITS_WEEKLY.costLimit,
    };
  }, [derivedLimits, solvedLimits]);

  const calibrationPlanTier =
    effectiveLimits?.calibratedAt && planPeriods.length > 0
      ? getPlanTierForDate(effectiveLimits.calibratedAt, planPeriods)
      : null;
  const calibrationPlanMultiplier = calibrationPlanTier
    ? PLAN_TIERS[calibrationPlanTier].multiplier
    : 1;

  // 5h-only limits for sessions count (weeklyX = null forces 5h mode)
  const fiveHourOnlyLimits = useMemo((): DerivedLimits => ({
    outputLimit: effectiveLimits?.outputLimit ?? DEFAULT_LIMITS_5H.outputLimit,
    inputOutputLimit: effectiveLimits?.inputOutputLimit ?? DEFAULT_LIMITS_5H.inputOutputLimit,
    totalLimit: effectiveLimits?.totalLimit ?? DEFAULT_LIMITS_5H.totalLimit,
    costLimit: effectiveLimits?.costLimit ?? DEFAULT_LIMITS_5H.costLimit,
    weeklyOutputLimit: null,
    weeklyInputOutputLimit: null,
    weeklyTotalLimit: null,
    weeklyCostLimit: null,
    calibratedAt: effectiveLimits?.calibratedAt ?? "",
    calibrationPct: 0,
    promoActive: false,
  }), [effectiveLimits]);

  const hasWeeklyLimits = effectiveLimits?.weeklyOutputLimit != null;

  const buildWeeklyRows = useMemo(
    () =>
      (buckets: WeeklyBucket[]): AggregatedWeekRow[] =>
        [...buckets]
          .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
          .map((bucket) => {
            const weekPlanTier =
              planPeriods.length > 0
                ? getPlanTierForDate(bucket.weekStart, planPeriods)
                : null;
            const weekPlanInfo = weekPlanTier ? PLAN_TIERS[weekPlanTier] : null;
            const weekPlanMultiplier =
              weekPlanInfo?.multiplier ?? calibrationPlanMultiplier;
            const planScale =
              calibrationPlanMultiplier > 0
                ? weekPlanMultiplier / calibrationPlanMultiplier
                : 1;
            const scaledLimits = buildScaledLimits(effectiveLimits, planScale);
            const normalizedUsage = {
              outputTokens: bucket.normalizedOutputTokens,
              inputTokens: bucket.normalizedInputTokens,
              totalTokens: bucket.normalizedTotalTokens,
              totalCost: bucket.normalizedCost,
            };
            const util = calcUtilization(
              normalizedUsage,
              scaledLimits,
              "peak",
              bucket.weekStart,
              "weekly",
              undefined,
              [],
              1,
              { promoMode: "ignore" }
            );

            // Sessions count: how many full 5h sessions fit in this week
            const scaled5h = buildScaledLimits(fiveHourOnlyLimits, planScale);
            const util5h = calcUtilization(
              normalizedUsage,
              scaled5h,
              "peak",
              bucket.weekStart,
              "5h",
              undefined,
              [],
              1,
              { promoMode: "ignore" }
            );

            // Keep the exact per-entry normalized values from bucket aggregation.
            const baseUsage = {
              output: bucket.normalizedOutputTokens,
              input: bucket.normalizedInputTokens,
              cacheWrite: bucket.normalizedCacheCreationTokens,
              cacheRead: bucket.normalizedCacheReadTokens,
              total: bucket.normalizedTotalTokens,
              cost: bucket.normalizedCost,
            };

            const outputPct = util?.outputPct ?? 0;
            const inoutPct = util?.inoutPct ?? 0;
            const totalPct = util?.totalPct ?? 0;
            const effectivePct = util?.effectivePct ?? 0;
            const pctForCost = effectivePct > 0 ? effectivePct : 1;
            const sessions5h = util5h ? Math.round(util5h.effectivePct / 100 * 10) / 10 : null;

            return {
              weekStart: bucket.weekStart,
              weekEnd: bucket.weekEnd,
              weekLabel: getWeekLabel(bucket.weekStart),
              dateRange: formatDateRange(bucket.weekStart, bucket.weekEnd),
              totalTokens: bucket.totalTokens,
              totalCost: bucket.totalCost,
              inputTokens: bucket.inputTokens,
              outputTokens: bucket.outputTokens,
              cacheCreationTokens: bucket.cacheCreationTokens,
              cacheReadTokens: bucket.cacheReadTokens,
              baseTotalTokens: baseUsage.total,
              baseCost: baseUsage.cost,
              baseInputTokens: baseUsage.input,
              baseOutputTokens: baseUsage.output,
              baseCacheCreationTokens: baseUsage.cacheWrite,
              baseCacheReadTokens: baseUsage.cacheRead,
              outputPct,
              inoutPct,
              totalPct,
              effectivePct,
              rawCostPer1Pct: bucket.totalCost / pctForCost,
              normalizedCostPer1Pct: baseUsage.cost / pctForCost,
              tokensPer1Pct: baseUsage.total / pctForCost,
              inputPer1Pct: baseUsage.input / pctForCost,
              outputPer1Pct: baseUsage.output / pctForCost,
              cacheCreationPer1Pct: baseUsage.cacheWrite / pctForCost,
              cacheReadPer1Pct: baseUsage.cacheRead / pctForCost,
              sessions5h,
              messageCount: bucket.messageCount,
              planTier: weekPlanTier,
              planLabel: weekPlanInfo?.label ?? "Unknown plan",
              planShortLabel: weekPlanInfo?.shortLabel ?? "—",
              planColor: weekPlanInfo?.color ?? "var(--text-muted)",
            };
          }),
    [calibrationPlanMultiplier, effectiveLimits, fiveHourOnlyLimits, planPeriods, promoPeriods]
  );

  const allRows = useMemo(() => buildWeeklyRows(weeklyAll), [buildWeeklyRows, weeklyAll]);
  const sonnetRows = useMemo(
    () => buildWeeklyRows(weeklySonnet),
    [buildWeeklyRows, weeklySonnet]
  );
  const selectedRows = scope === "all" ? allRows : sonnetRows;

  const chartData = useMemo(
    () =>
      selectedRows.map((week) => ({
        name: week.weekLabel,
        fullRange: week.dateRange,
        planLabel: week.planLabel,
        planColor: week.planColor,
        rawPct: week.effectivePct,
        effectivePct: Math.min(week.effectivePct, 100),
        overLimit:
          week.effectivePct > 100
            ? Math.min(week.effectivePct, WEEKLY_CHART_CAP_PCT) - 100
            : 0,
        isCapped: week.effectivePct > WEEKLY_CHART_CAP_PCT,
      })),
    [selectedRows]
  );

  const latestWeek =
    selectedRows.length > 0 ? selectedRows[selectedRows.length - 1] : null;
  const weeklyPer1TrendData = useMemo(
    () =>
      selectedRows.map((week) => ({
        name: week.weekLabel,
        fullLabel: `${week.dateRange} · ${week.planShortLabel}`,
        rawCostPer1Pct: week.rawCostPer1Pct,
        normalizedCostPer1Pct: week.normalizedCostPer1Pct,
        tokensPer1Pct: week.tokensPer1Pct,
        planColor: week.planColor,
        planShortLabel: week.planShortLabel,
        planLabel: week.planLabel,
      })),
    [selectedRows]
  );

  const visiblePlans = useMemo(() => {
    const seen = new Map<string, { shortLabel: string; label: string; color: string }>();
    for (const week of selectedRows) {
      if (!week.planTier) continue;
      if (!seen.has(week.planTier)) {
        seen.set(week.planTier, {
          shortLabel: week.planShortLabel,
          label: week.planLabel,
          color: week.planColor,
        });
      }
    }
    return Array.from(seen.values());
  }, [selectedRows]);

  const fiveHourAverageRows = useMemo(() => {
    return [...weeklyAll]
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
      .map((bucket): FiveHourAverageRow | null => {
        const weekWindows = windows.filter((window) => {
          const start = new Date(window.startTime).getTime();
          return (
            start >= new Date(bucket.weekStart).getTime() &&
            start < new Date(bucket.weekEnd).getTime()
          );
        });

        if (weekWindows.length === 0) return null;

        const weekPlanTier =
          planPeriods.length > 0
            ? getPlanTierForDate(bucket.weekStart, planPeriods)
            : null;
        const weekPlanInfo = weekPlanTier ? PLAN_TIERS[weekPlanTier] : null;
        const weekPlanMultiplier =
          weekPlanInfo?.multiplier ?? calibrationPlanMultiplier;
        const planScale =
          calibrationPlanMultiplier > 0
            ? weekPlanMultiplier / calibrationPlanMultiplier
            : 1;
        const scaledLimits = buildScaledLimits(effectiveLimits, planScale);

        const pctValues = weekWindows
          .map((window) => {
            const normalizedUsage = {
              outputTokens: window.normalizedOutputTokens,
              inputTokens: window.normalizedInputTokens,
              totalTokens: window.normalizedTotalTokens,
              totalCost: window.normalizedCost,
            };
            return (
              calcUtilization(
                normalizedUsage,
                scaledLimits,
                "peak",
                window.startTime,
                "5h",
                undefined,
                [],
                1,
                { promoMode: "ignore" }
              )?.effectivePct ?? null
            );
          })
          .filter((value): value is number => value != null);

        const totalInput = weekWindows.reduce(
          (sum, window) => sum + window.inputTokens,
          0
        );
        const totalOutput = weekWindows.reduce(
          (sum, window) => sum + window.outputTokens,
          0
        );
        const totalCacheCreation = weekWindows.reduce(
          (sum, window) => sum + window.cacheCreationTokens,
          0
        );
        const totalCacheRead = weekWindows.reduce(
          (sum, window) => sum + window.cacheReadTokens,
          0
        );
        const totalTokens = weekWindows.reduce(
          (sum, window) => sum + window.totalTokens,
          0
        );
        const totalCost = weekWindows.reduce(
          (sum, window) => sum + window.totalCost,
          0
        );
        const n = weekWindows.length;

        return {
          weekStart: bucket.weekStart,
          dateRange: formatDateRange(bucket.weekStart, bucket.weekEnd),
          planLabel: weekPlanInfo?.label ?? "Unknown plan",
          planShortLabel: weekPlanInfo?.shortLabel ?? "—",
          planColor: weekPlanInfo?.color ?? "var(--text-muted)",
          windowCount: n,
          avgPct:
            pctValues.length > 0
              ? pctValues.reduce((sum, value) => sum + value, 0) / pctValues.length
              : null,
          avgCost: totalCost / n,
          avgInputTokens: totalInput / n,
          avgOutputTokens: totalOutput / n,
          avgCacheCreationTokens: totalCacheCreation / n,
          avgCacheReadTokens: totalCacheRead / n,
          avgTotalTokens: totalTokens / n,
          totalCost,
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalCacheCreationTokens: totalCacheCreation,
          totalCacheReadTokens: totalCacheRead,
          totalTokens,
        };
      })
      .filter((row): row is FiveHourAverageRow => row != null);
  }, [
    calibrationPlanMultiplier,
    effectiveLimits,
    planPeriods,
    promoPeriods,
    weeklyAll,
    windows,
  ]);

  const sortedWindows = useMemo(
    () => [...windows].sort((a, b) => b.startTime.localeCompare(a.startTime)),
    [windows]
  );
  const windowPageCount = Math.max(1, Math.ceil(sortedWindows.length / WINDOWS_PAGE_SIZE));
  const currentWindowPage = Math.min(windowPage, windowPageCount);
  const currentWindowStartIndex =
    sortedWindows.length === 0 ? 0 : (currentWindowPage - 1) * WINDOWS_PAGE_SIZE;
  const currentWindowEndIndex = Math.min(
    currentWindowStartIndex + WINDOWS_PAGE_SIZE,
    sortedWindows.length
  );
  const allWindowRows = useMemo(
    () =>
      sortedWindows.map((win) => {
        const windowPlanTier =
          planPeriods.length > 0
            ? getPlanTierForDate(win.startTime, planPeriods)
            : null;
        const windowPlanInfo = windowPlanTier ? PLAN_TIERS[windowPlanTier] : null;
        const windowPlanMultiplier =
          windowPlanInfo?.multiplier ?? calibrationPlanMultiplier;
        const planScale =
          calibrationPlanMultiplier > 0
            ? windowPlanMultiplier / calibrationPlanMultiplier
            : 1;
        const scaledLimits = buildScaledLimits(effectiveLimits, planScale);
        const normalizedUsage = {
          outputTokens: win.normalizedOutputTokens,
          inputTokens: win.normalizedInputTokens,
          totalTokens: win.normalizedTotalTokens,
          totalCost: win.normalizedCost,
        };
        const util = calcUtilization(
          normalizedUsage,
          scaledLimits,
          "peak",
          win.startTime,
          "5h",
          undefined,
          [],
          1,
          { promoMode: "ignore" }
        );
        const pct = util?.effectivePct ?? 0;
        const pctForCost = pct > 0 ? pct : 1;
        const topModels = Object.entries(win.models)
          .sort((a, b) => b[1].totalCost - a[1].totalCost)
          .slice(0, 3)
          .map(([name, stats]) => `${name}(${stats.messageCount})`)
          .join(", ");

        return {
          win,
          windowPlanInfo,
          pct,
          pctForCost,
          topModels,
        };
      }),
    [
      calibrationPlanMultiplier,
      effectiveLimits,
      planPeriods,
      promoPeriods,
      sortedWindows,
    ]
  );
  const visibleWindowRows = useMemo(
    () => allWindowRows.slice(currentWindowStartIndex, currentWindowEndIndex),
    [allWindowRows, currentWindowStartIndex, currentWindowEndIndex]
  );
  const latestVisibleWindow = visibleWindowRows[0] ?? null;
  const fiveHourPer1TrendData = useMemo(
    () =>
      [...visibleWindowRows]
        .reverse()
        .map(({ win, windowPlanInfo, pctForCost }) => ({
          name: new Date(win.startTime).toLocaleDateString("pl-PL", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }),
          fullLabel: `${new Date(win.startTime).toLocaleDateString("pl-PL", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })} · ${win.peakStatus} · ${windowPlanInfo?.shortLabel ?? "—"}`,
          rawCostPer1Pct: win.totalCost / pctForCost,
          normalizedCostPer1Pct: win.normalizedCost / pctForCost,
          tokensPer1Pct: win.normalizedTotalTokens / pctForCost,
          planColor: windowPlanInfo?.color ?? "var(--text-muted)",
          planShortLabel: windowPlanInfo?.shortLabel ?? "—",
          planLabel: windowPlanInfo?.label ?? "Unknown plan",
        })),
    [visibleWindowRows]
  );

  // All windows trend data (chronological)
  const allFiveHourPer1TrendData = useMemo(
    () =>
      [...allWindowRows]
        .reverse()
        .map(({ win, windowPlanInfo, pctForCost }) => ({
          name: new Date(win.startTime).toLocaleDateString("pl-PL", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }),
          fullLabel: `${new Date(win.startTime).toLocaleDateString("pl-PL", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })} · ${win.peakStatus} · ${windowPlanInfo?.shortLabel ?? "—"}`,
          rawCostPer1Pct: win.totalCost / pctForCost,
          normalizedCostPer1Pct: win.normalizedCost / pctForCost,
          tokensPer1Pct: win.normalizedTotalTokens / pctForCost,
          planColor: windowPlanInfo?.color ?? "var(--text-muted)",
          planShortLabel: windowPlanInfo?.shortLabel ?? "—",
          planLabel: windowPlanInfo?.label ?? "Unknown plan",
        })),
    [allWindowRows]
  );

  // Daily aggregated trend (average per-1% values per day)
  const dailyFiveHourPer1TrendData = useMemo(() => {
    const byDay = new Map<string, Array<(typeof allWindowRows)[0]>>();
    for (const row of allWindowRows) {
      const dayKey = row.win.startTime.slice(0, 10);
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey)!.push(row);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, rows]): Per1TrendPoint => {
        const n = rows.length;
        const avgRaw = rows.reduce((s, r) => s + r.win.totalCost / r.pctForCost, 0) / n;
        const avgNorm = rows.reduce((s, r) => s + r.win.normalizedCost / r.pctForCost, 0) / n;
        const avgTok = rows.reduce((s, r) => s + r.win.normalizedTotalTokens / r.pctForCost, 0) / n;
        const last = rows[rows.length - 1];
        return {
          name: new Date(day + "T12:00:00Z").toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" }),
          fullLabel: `${day} (${n} okien) · avg · ${last.windowPlanInfo?.shortLabel ?? "—"}`,
          rawCostPer1Pct: avgRaw,
          normalizedCostPer1Pct: avgNorm,
          tokensPer1Pct: avgTok,
          planColor: last.windowPlanInfo?.color ?? "var(--text-muted)",
          planShortLabel: last.windowPlanInfo?.shortLabel ?? "—",
          planLabel: last.windowPlanInfo?.label ?? "Unknown plan",
        };
      });
  }, [allWindowRows]);

  // Weekly aggregated trend (average per-1% values per week)
  const weeklyFiveHourPer1TrendData = useMemo(() => {
    const byWeek = new Map<string, { key: string; rows: Array<(typeof allWindowRows)[0]> }>();
    for (const row of allWindowRows) {
      const wk = getWeekLabel(row.win.startTime);
      const year = new Date(row.win.startTime).getFullYear();
      const mapKey = `${year}-${wk}`;
      if (!byWeek.has(mapKey)) byWeek.set(mapKey, { key: mapKey, rows: [] });
      byWeek.get(mapKey)!.rows.push(row);
    }
    return [...byWeek.values()]
      .sort((a, b) => a.rows[0].win.startTime.localeCompare(b.rows[0].win.startTime))
      .map(({ rows }): Per1TrendPoint => {
        const n = rows.length;
        const avgRaw = rows.reduce((s, r) => s + r.win.totalCost / r.pctForCost, 0) / n;
        const avgNorm = rows.reduce((s, r) => s + r.win.normalizedCost / r.pctForCost, 0) / n;
        const avgTok = rows.reduce((s, r) => s + r.win.normalizedTotalTokens / r.pctForCost, 0) / n;
        const last = rows[rows.length - 1];
        const wk = getWeekLabel(rows[0].win.startTime);
        return {
          name: wk,
          fullLabel: `${wk} (${n} okien) · avg · ${last.windowPlanInfo?.shortLabel ?? "—"}`,
          rawCostPer1Pct: avgRaw,
          normalizedCostPer1Pct: avgNorm,
          tokensPer1Pct: avgTok,
          planColor: last.windowPlanInfo?.color ?? "var(--text-muted)",
          planShortLabel: last.windowPlanInfo?.shortLabel ?? "—",
          planLabel: last.windowPlanInfo?.label ?? "Unknown plan",
        };
      });
  }, [allWindowRows]);

  const selectedFiveHourTrendData = (() => {
    switch (trendScope5h) {
      case "page": return fiveHourPer1TrendData;
      case "all": return allFiveHourPer1TrendData;
      case "daily": return dailyFiveHourPer1TrendData;
      case "weekly": return weeklyFiveHourPer1TrendData;
    }
  })();

  useEffect(() => {
    setWindowPage((prev) => Math.min(prev, windowPageCount));
  }, [windowPageCount]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Period tabs */}
      <div className="flex items-center gap-4">
        <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5">
          {([
            ["week", "Weekly"],
            ["5h", "5h Windows"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
                period === key
                  ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <ScopeTabs value={scope} onChange={setScope} />
      </div>

      {period === "week" && (
      <>
      <div className="card p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-medium text-[var(--text-secondary)]">
              Weekly Utilization (100% = Limit)
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Kolor słupka = plan aktywny w danym tygodniu. Pomarańczowy segment to część ponad
              limit. Zakres wykresu jest przycięty do {WEEKLY_CHART_CAP_PCT}%.
            </p>
          </div>
        </div>

        {selectedRows.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Brak danych dla tego widoku.</p>
        ) : (
          <>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barSize={24}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border-subtle)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="name"
                    tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                    axisLine={{ stroke: "var(--border-subtle)" }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, WEEKLY_CHART_CAP_PCT]}
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={45}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(
                      value: number,
                      name: string,
                      item: {
                        payload?: {
                          rawPct?: number;
                          isCapped?: boolean;
                          planLabel?: string;
                        };
                      }
                    ) => {
                      const rawPct = item?.payload?.rawPct ?? value;
                      const suffix = item?.payload?.isCapped ? " (chart capped)" : "";
                      return [
                        name === "effectivePct"
                          ? `${rawPct.toFixed(1)}%${suffix}`
                          : `+${Math.max(rawPct - 100, 0).toFixed(1)}%${suffix}`,
                        name === "effectivePct"
                          ? `Utilization • ${item?.payload?.planLabel ?? "Unknown plan"}`
                          : "Over limit",
                      ];
                    }}
                  />
                  <Bar dataKey="effectivePct" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry) => (
                      <Cell
                        key={`cell-${entry.fullRange}`}
                        fill={entry.planColor}
                        opacity={entry.effectivePct >= 80 ? 1 : 0.7}
                      />
                    ))}
                  </Bar>
                  <Bar
                    dataKey="overLimit"
                    fill="var(--accent-orange)"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="flex gap-4 mt-3 justify-center text-xs text-[var(--text-muted)]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--accent-blue)]" />
                Plan color
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--accent-orange)]" />
                Over limit
              </span>
            </div>

            {visiblePlans.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3 justify-center">
                {visiblePlans.map((plan) => (
                  <span
                    key={plan.shortLabel}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium"
                    style={{
                      color: plan.color,
                      background: `color-mix(in srgb, ${plan.color} 14%, transparent)`,
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ background: plan.color }}
                    />
                    {plan.shortLabel} • {plan.label}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {selectedRows.length > 1 && (
        <Per1TrendChart
          title="1% Trend"
          description="Trend tygodniowy dla `Norm $/1%`, `Raw $/1%` i `Base Tot/1%`, żeby szybciej ocenić, czy limit puchnie przez tydzień."
          data={weeklyPer1TrendData}
        />
      )}

      {latestWeek && (
        <div className="card p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-medium text-[var(--text-secondary)]">
                1% Cost & Token Breakdown
              </h3>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Latest week in view: {latestWeek.dateRange} ({scope === "all" ? "ALL" : "SONNET"})
              </p>
              <p className="text-[11px] text-[var(--text-muted)] mt-1">
                `W%` jest estymowanym utilization na bazie `1x / no promo`. `Raw $/1%`
                liczy realny spend z JSONL, a `Norm $/1%` liczy spend po zdjęciu promo.
              </p>
            </div>
            <ScopeTabs value={scope} onChange={setScope} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Norm Cost per 1%
              </div>
              <div className="text-2xl font-semibold text-[var(--accent-green)] tabular-nums">
                {formatCost(latestWeek.normalizedCostPer1Pct)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                no promo base · {latestWeek.effectivePct.toFixed(1)}% utilization
              </div>
            </div>
            <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Raw Cost per 1%
              </div>
              <div className="text-2xl font-semibold text-[var(--accent-orange)] tabular-nums">
                {formatCost(latestWeek.rawCostPer1Pct)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                realny spend z JSONL
              </div>
            </div>
            <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Base Tokens per 1%
              </div>
              <div className="text-2xl font-semibold text-[var(--accent-blue)] tabular-nums">
                {formatTokens(latestWeek.tokensPer1Pct)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                {formatTokens(latestWeek.baseTotalTokens)} base total
              </div>
            </div>
            <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Week Cost
              </div>
              <div className="text-2xl font-semibold text-[var(--accent-purple)] tabular-nums">
                {formatCost(latestWeek.totalCost)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                norm {formatCost(latestWeek.baseCost)} · {latestWeek.messageCount} messages
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">Base In / 1%</div>
              <div className="text-sm font-medium text-[var(--accent-blue)] tabular-nums">
                {formatTokens(latestWeek.inputPer1Pct)}
              </div>
            </div>
            <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">Base Out / 1%</div>
              <div className="text-sm font-medium text-[var(--accent-green)] tabular-nums">
                {formatTokens(latestWeek.outputPer1Pct)}
              </div>
            </div>
            <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">
                Base CW / 1%
              </div>
              <div className="text-sm font-medium text-[var(--accent-purple)] tabular-nums">
                {formatTokens(latestWeek.cacheCreationPer1Pct)}
              </div>
            </div>
            <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">
                Base CR / 1%
              </div>
              <div className="text-sm font-medium text-[var(--accent-cyan)] tabular-nums">
                {formatTokens(latestWeek.cacheReadPer1Pct)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card p-5 overflow-x-auto">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-medium text-[var(--text-secondary)]">
              Weekly Breakdown
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Osobny widok dla ALL models i SONNET only. `Raw` = surowe JSONL.
              `Norm` = baza 1x po zdjęciu promo.
            </p>
          </div>
          <ScopeTabs value={scope} onChange={setScope} />
        </div>

        {selectedRows.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Brak danych dla tego widoku.</p>
        ) : (
          <table className="w-full text-[11px]">
            <colgroup>
              {/* Info: Week, Plan, W%, ×5h */}
              <col />
              <col />
              <col />
              <col />
              {/* Raw Usage: Cost, All, In, Out, CW, CR */}
              <col className="border-l border-[var(--border-subtle)]" />
              <col />
              <col />
              <col />
              <col />
              <col />
              {/* Per 1% (base): Raw $/1%, Norm $/1%, In, Out, CW, CR, Tot */}
              <col className="border-l border-[var(--border-subtle)]" />
              <col />
              <col />
              <col />
              <col />
              <col />
              <col />
              {/* Est 100%: Cost, Output, Total */}
              <col className="border-l border-[var(--border-subtle)]" />
              <col />
              <col />
              {/* Msgs */}
              <col />
            </colgroup>
            <thead>
              <tr className="text-[9px] uppercase tracking-wider">
                <th colSpan={4} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal">
                  Info
                </th>
                <th colSpan={6} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                  Raw Usage
                </th>
                <th colSpan={7} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                  Per 1% (base)
                </th>
                <th colSpan={3} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                  Est. 100% limit (base)
                </th>
                <th />
              </tr>
              <tr className="border-b border-[var(--border-subtle)]">
                <th className="text-left py-1 px-1.5 text-[var(--text-muted)] font-medium">Week</th>
                <th className="text-left py-1 px-1.5 text-[var(--text-muted)] font-medium">Plan</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium" title="Estimated weekly utilization">
                  {hasWeeklyLimits ? "W%" : "%"}
                </th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium" title="Full 5h sessions equivalent">×5h</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Cost</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">All</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">In</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Out</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheW</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheR</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Raw $/1%</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Norm $/1%</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">In/1%</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Out/1%</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CW/1%</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CR/1%</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Tot/1%</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Norm Cost</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Output</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Total</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Msgs</th>
              </tr>
            </thead>
            <tbody>
              {selectedRows
                .slice()
                .reverse()
                .map((week, idx) => (
                  <tr
                    key={week.weekStart}
                    className={`border-b border-[var(--border-subtle)] ${
                      idx === 0 ? "bg-[var(--bg-secondary)]" : ""
                    }`}
                  >
                    {/* Info */}
                    <td className="py-1 px-1.5 text-[var(--text-secondary)] whitespace-nowrap">{week.dateRange}</td>
                    <td className="py-1 px-1.5">
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                        style={{
                          color: week.planColor,
                          background: `color-mix(in srgb, ${week.planColor} 14%, transparent)`,
                        }}
                        title={week.planLabel}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: week.planColor }}
                        />
                        {week.planShortLabel}
                      </span>
                    </td>
                    <td
                      className="py-1 px-1.5 text-right tabular-nums font-medium"
                      style={{
                        color:
                          week.effectivePct >= 100
                            ? "var(--accent-red)"
                            : week.effectivePct >= 80
                            ? "var(--accent-orange)"
                            : "var(--text-secondary)",
                      }}
                    >
                      {week.effectivePct.toFixed(1)}%
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-purple)]">
                      {week.sessions5h != null ? `${week.sessions5h.toFixed(1)}×` : "—"}
                    </td>
                    {/* Raw Usage */}
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                      {formatCost(week.totalCost)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                      {formatTokens(week.totalTokens)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                      {formatTokens(week.inputTokens)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                      {formatTokens(week.outputTokens)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                      {formatTokens(week.cacheCreationTokens)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                      {formatTokens(week.cacheReadTokens)}
                    </td>
                    {/* Per 1% (base) */}
                    <td className="py-1 px-1.5 text-right tabular-nums font-medium text-[var(--text-primary)] border-l border-[var(--border-subtle)]">
                      {formatCost(week.rawCostPer1Pct)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums font-medium text-[var(--accent-green)]">
                      {formatCost(week.normalizedCostPer1Pct)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                      {formatTokens(week.inputPer1Pct)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                      {formatTokens(week.outputPer1Pct)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                      {formatTokens(week.cacheCreationPer1Pct)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                      {formatTokens(week.cacheReadPer1Pct)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                      {formatTokens(week.tokensPer1Pct)}
                    </td>
                    {/* Est. 100% */}
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                      {formatCost(week.normalizedCostPer1Pct * 100)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-blue)]">
                      {formatTokens(week.outputPer1Pct * 100)}
                    </td>
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-cyan)]">
                      {formatTokens(week.tokensPer1Pct * 100)}
                    </td>
                    {/* Msgs */}
                    <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                      {week.messageCount}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card p-5 overflow-x-auto">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-1">
          5h Average By Week
        </h3>
        <p className="text-xs text-[var(--text-muted)] mb-4">
          Średnia na jedno okno 5h wewnątrz tygodnia. `Avg %` = estymowany utilization,
          tokeny i koszt to surowe (`raw`) średnie per okno.
        </p>

        {fiveHourAverageRows.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Brak danych 5h.</p>
        ) : (
          <table className="w-full text-[11px]">
            <colgroup>
              {/* Info: Week, Plan, Avg %, Win */}
              <col />
              <col />
              <col />
              <col />
              {/* Avg per 5h window: Cost, All, In, Out, CW, CR */}
              <col className="border-l border-[var(--border-subtle)]" />
              <col />
              <col />
              <col />
              <col />
              <col />
              {/* Week totals: Cost, All, In, Out, CW, CR */}
              <col className="border-l border-[var(--border-subtle)]" />
              <col />
              <col />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr className="text-[9px] uppercase tracking-wider">
                <th colSpan={4} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal">
                  Info
                </th>
                <th colSpan={6} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                  Avg per 5h window (raw)
                </th>
                <th colSpan={6} className="text-left py-0.5 px-1.5 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                  Week totals (raw)
                </th>
              </tr>
              <tr className="border-b border-[var(--border-subtle)]">
                <th className="text-left py-1 px-1.5 text-[var(--text-muted)] font-medium">Week</th>
                <th className="text-left py-1 px-1.5 text-[var(--text-muted)] font-medium">Plan</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium" title="Average 5h window utilization">Avg %</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium" title="Number of 5h windows">Win</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Cost</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">All</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">In</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Out</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheW</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheR</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Cost</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">All</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">In</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">Out</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheW</th>
                <th className="text-right py-1 px-1.5 text-[var(--text-muted)] font-medium">CacheR</th>
              </tr>
            </thead>
            <tbody>
              {fiveHourAverageRows.map((week, idx) => (
                <tr
                  key={week.weekStart}
                  className={`border-b border-[var(--border-subtle)] ${
                    idx === 0 ? "bg-[var(--bg-secondary)]" : ""
                  }`}
                >
                  {/* Info */}
                  <td className="py-1 px-1.5 text-[var(--text-secondary)] whitespace-nowrap">{week.dateRange}</td>
                  <td className="py-1 px-1.5">
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={{
                        color: week.planColor,
                        background: `color-mix(in srgb, ${week.planColor} 14%, transparent)`,
                      }}
                      title={week.planLabel}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: week.planColor }}
                      />
                      {week.planShortLabel}
                    </span>
                  </td>
                  <td
                    className="py-1 px-1.5 text-right tabular-nums font-medium"
                    style={{
                      color:
                        week.avgPct == null
                          ? "var(--text-muted)"
                          : week.avgPct >= 100
                          ? "var(--accent-red)"
                          : week.avgPct >= 80
                          ? "var(--accent-orange)"
                          : "var(--text-secondary)",
                    }}
                  >
                    {week.avgPct != null ? `${week.avgPct.toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {week.windowCount}
                  </td>
                  {/* Avg per 5h window */}
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                    {formatCost(week.avgCost)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                    {formatTokens(week.avgTotalTokens)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {formatTokens(week.avgInputTokens)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {formatTokens(week.avgOutputTokens)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {formatTokens(week.avgCacheCreationTokens)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {formatTokens(week.avgCacheReadTokens)}
                  </td>
                  {/* Week totals */}
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                    {formatCost(week.totalCost)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-secondary)]">
                    {formatTokens(week.totalTokens)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {formatTokens(week.totalInputTokens)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {formatTokens(week.totalOutputTokens)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {formatTokens(week.totalCacheCreationTokens)}
                  </td>
                  <td className="py-1 px-1.5 text-right tabular-nums text-[var(--text-muted)]">
                    {formatTokens(week.totalCacheReadTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </>
      )}

      {/* 5h Windows view */}
      {period === "5h" && (
        <>
        {/* 5h per-window chart */}
        <div className="card p-5 mb-4">
          <div className="mb-4">
            <h3 className="text-sm font-medium text-[var(--text-secondary)]">
              5h Window Timeline
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Ostatnie 50 okien 5h — koszt i % per okno.
            </p>
          </div>
          {windows.length > 0 && (() => {
            const sorted = [...windows].sort((a, b) => a.startTime.localeCompare(b.startTime)).slice(-50);
            const winChartData = sorted.map((win) => {
              const windowPlanTier =
                planPeriods.length > 0
                  ? getPlanTierForDate(win.startTime, planPeriods)
                  : null;
              const windowPlanInfo = windowPlanTier ? PLAN_TIERS[windowPlanTier] : null;
              const windowPlanMultiplier =
                windowPlanInfo?.multiplier ?? calibrationPlanMultiplier;
              const planScale =
                calibrationPlanMultiplier > 0
                  ? windowPlanMultiplier / calibrationPlanMultiplier
                  : 1;
              const scaledLimits = buildScaledLimits(effectiveLimits, planScale);
              const normalizedUsage = {
                outputTokens: win.normalizedOutputTokens,
                inputTokens: win.normalizedInputTokens,
                totalTokens: win.normalizedTotalTokens,
                totalCost: win.normalizedCost,
              };
              const util = calcUtilization(
                normalizedUsage,
                scaledLimits,
                "peak",
                win.startTime,
                "5h",
                undefined,
                [],
                1,
                { promoMode: "ignore" }
              );
              return {
                name: new Date(win.startTime).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
                pct: Math.min(util?.effectivePct ?? 0, 150),
                rawPct: util?.effectivePct ?? 0,
                cost: win.totalCost,
                normCost: win.normalizedCost,
                peak: win.peakStatus === "peak",
                color: win.peakStatus === "peak" ? "var(--accent-red)" : "var(--accent-blue)",
              };
            });
            return (
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={winChartData} barSize={8}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: "var(--text-muted)", fontSize: 8 }} axisLine={{ stroke: "var(--border-subtle)" }} tickLine={false} interval="preserveStartEnd" angle={-45} textAnchor="end" height={60} />
                    <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: "var(--text-muted)", fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip
                      contentStyle={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                      formatter={(value: number, _name: string, item: { payload?: { rawPct?: number; cost?: number; normCost?: number; peak?: boolean } }) => [
                        `${(item?.payload?.rawPct ?? value).toFixed(1)}% · raw ${formatCost(item?.payload?.cost ?? 0)} · norm ${formatCost(item?.payload?.normCost ?? 0)}${item?.payload?.peak ? " (peak)" : ""}`,
                        "5h window",
                      ]}
                    />
                    <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
                      {winChartData.map((entry) => (
                        <Cell key={`wincell-${entry.name}`} fill={entry.color} opacity={0.75} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            );
          })()}
        </div>

        {allWindowRows.length > 1 && (
          <Per1TrendChart
            title="1% Trend"
            description={
              trendScope5h === "page"
                ? `Strona ${currentWindowStartIndex + 1}-${currentWindowEndIndex} z ${sortedWindows.length} okien 5h.`
                : trendScope5h === "all"
                ? `Wszystkie ${allFiveHourPer1TrendData.length} okien 5h.`
                : trendScope5h === "daily"
                ? `Średnie dzienne z ${dailyFiveHourPer1TrendData.length} dni (${allWindowRows.length} okien).`
                : `Średnie tygodniowe z ${weeklyFiveHourPer1TrendData.length} tygodni (${allWindowRows.length} okien).`
            }
            data={selectedFiveHourTrendData}
            headerExtra={
              <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5 flex-shrink-0">
                {([
                  ["page", "Page"],
                  ["all", "All"],
                  ["daily", "Daily"],
                  ["weekly", "Weekly"],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setTrendScope5h(key)}
                    className={`px-2.5 py-1 rounded text-[10px] font-medium transition-all ${
                      trendScope5h === key
                        ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
                        : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          />
        )}

        {latestVisibleWindow && (
          <div className="card p-5">
            <div className="mb-4">
              <h3 className="text-sm font-medium text-[var(--text-secondary)]">
                1% Cost & Token Breakdown
              </h3>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Okno 5h na tej stronie: {new Date(latestVisibleWindow.win.startTime).toLocaleDateString("pl-PL", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })} · {latestVisibleWindow.win.peakStatus} · {latestVisibleWindow.windowPlanInfo?.shortLabel ?? "—"}
              </p>
              <p className="text-[11px] text-[var(--text-muted)] mt-1">
                `%` jest estymowanym utilization na bazie `1x / no promo`. `Raw $/1%`
                liczy realny spend z JSONL, a `Norm $/1%` liczy spend po zdjęciu promo.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
                <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                  Norm Cost per 1%
                </div>
                <div className="text-2xl font-semibold text-[var(--accent-green)] tabular-nums">
                  {formatCost(latestVisibleWindow.win.normalizedCost / latestVisibleWindow.pctForCost)}
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-1">
                  no promo base · {latestVisibleWindow.pct.toFixed(1)}% utilization
                </div>
              </div>
              <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
                <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                  Raw Cost per 1%
                </div>
                <div className="text-2xl font-semibold text-[var(--accent-orange)] tabular-nums">
                  {formatCost(latestVisibleWindow.win.totalCost / latestVisibleWindow.pctForCost)}
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-1">
                  realny spend z JSONL
                </div>
              </div>
              <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
                <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                  Base Tokens per 1%
                </div>
                <div className="text-2xl font-semibold text-[var(--accent-blue)] tabular-nums">
                  {formatTokens(latestVisibleWindow.win.normalizedTotalTokens / latestVisibleWindow.pctForCost)}
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-1">
                  {formatTokens(latestVisibleWindow.win.normalizedTotalTokens)} base total
                </div>
              </div>
              <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
                <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                  Window Cost
                </div>
                <div className="text-2xl font-semibold text-[var(--accent-purple)] tabular-nums">
                  {formatCost(latestVisibleWindow.win.totalCost)}
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-1">
                  norm {formatCost(latestVisibleWindow.win.normalizedCost)} · {latestVisibleWindow.win.messageCount} messages
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
                <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">Base In / 1%</div>
                <div className="text-sm font-medium text-[var(--accent-blue)] tabular-nums">
                  {formatTokens(latestVisibleWindow.win.normalizedInputTokens / latestVisibleWindow.pctForCost)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
                <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">Base Out / 1%</div>
                <div className="text-sm font-medium text-[var(--accent-green)] tabular-nums">
                  {formatTokens(latestVisibleWindow.win.normalizedOutputTokens / latestVisibleWindow.pctForCost)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
                <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">
                  Base CW / 1%
                </div>
                <div className="text-sm font-medium text-[var(--accent-purple)] tabular-nums">
                  {formatTokens(latestVisibleWindow.win.normalizedCacheCreationTokens / latestVisibleWindow.pctForCost)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
                <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">
                  Base CR / 1%
                </div>
                <div className="text-sm font-medium text-[var(--accent-cyan)] tabular-nums">
                  {formatTokens(latestVisibleWindow.win.normalizedCacheReadTokens / latestVisibleWindow.pctForCost)}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="card p-5">
          <div className="mb-4">
            <h3 className="text-sm font-medium text-[var(--text-secondary)]">
              5h Window Breakdown
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Poszczególne okna 5-godzinne. `%` jest estymowanym utilization na bazie
              `1x / no promo`. `Raw` pokazuje surowe usage z JSONL, a `Norm` usage po
              zdjęciu promo per entry. Lista jest stronicowana po {WINDOWS_PAGE_SIZE} okien.
            </p>
          </div>

          {windows.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Brak danych okien 5h.</p>
          ) : (
            <div className="space-y-3">
              <PaginationControls
                page={currentWindowPage}
                pageCount={windowPageCount}
                pageStart={currentWindowStartIndex + 1}
                pageEnd={currentWindowEndIndex}
                totalItems={sortedWindows.length}
                itemLabel="okien"
                onPageChange={setWindowPage}
              />
              <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider">
                    <th colSpan={4} className="text-left py-0.5 px-2 text-[var(--text-muted)] font-normal">
                      Info
                    </th>
                    <th colSpan={6} className="text-left py-0.5 px-2 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Raw Usage
                    </th>
                    <th colSpan={7} className="text-left py-0.5 px-2 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Per 1% (base)
                    </th>
                    <th colSpan={3} className="text-left py-0.5 px-2 text-[var(--text-muted)] font-normal border-l border-[var(--border-subtle)]">
                      Est. 100% limit (base)
                    </th>
                    <th colSpan={2} />
                  </tr>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Window</th>
                    <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Plan</th>
                    <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Peak</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Cost</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">All</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">In</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Out</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">CacheW</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">CacheR</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Raw $/1%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Norm $/1%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">In/1%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Out/1%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">CW/1%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">CR/1%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Tot/1%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium border-l border-[var(--border-subtle)]">Norm Cost</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Output</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Total</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Msgs</th>
                    <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Models</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWindowRows.map(({ win, windowPlanInfo, pct, pctForCost, topModels }) => {
                      return (
                        <tr
                          key={win.id}
                          className="border-b border-[var(--border-subtle)]"
                        >
                          <td className="py-1.5 px-2 text-[var(--text-secondary)] whitespace-nowrap">
                            {new Date(win.startTime).toLocaleDateString("pl-PL", {
                              day: "2-digit",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td className="py-1.5 px-2">
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{
                                color: windowPlanInfo?.color ?? "var(--text-muted)",
                                background: windowPlanInfo
                                  ? `color-mix(in srgb, ${windowPlanInfo.color} 14%, transparent)`
                                  : "var(--bg-secondary)",
                              }}
                              title={windowPlanInfo?.label ?? "Unknown plan"}
                            >
                              {windowPlanInfo?.shortLabel ?? "—"}
                            </span>
                          </td>
                          <td className="py-1.5 px-2">
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{
                                color:
                                  win.peakStatus === "peak"
                                    ? "var(--accent-red)"
                                    : win.peakStatus === "off-peak"
                                    ? "var(--accent-green)"
                                    : "var(--accent-orange)",
                                background:
                                  win.peakStatus === "peak"
                                    ? "color-mix(in srgb, var(--accent-red) 12%, transparent)"
                                    : win.peakStatus === "off-peak"
                                    ? "color-mix(in srgb, var(--accent-green) 12%, transparent)"
                                    : "color-mix(in srgb, var(--accent-orange) 12%, transparent)",
                              }}
                            >
                              {win.peakStatus}
                            </span>
                          </td>
                          <td
                            className="py-1.5 px-2 text-right tabular-nums font-medium"
                            style={{
                              color:
                                pct >= 100
                                  ? "var(--accent-red)"
                                  : pct >= 80
                                  ? "var(--accent-orange)"
                                  : "var(--text-secondary)",
                            }}
                          >
                            {pct.toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                            {formatCost(win.totalCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-secondary)]">
                            {formatTokens(win.totalTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.inputTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.outputTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.cacheCreationTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.cacheReadTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-primary)] border-l border-[var(--border-subtle)]">
                            {formatCost(win.totalCost / pctForCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--accent-green)]">
                            {formatCost(win.normalizedCost / pctForCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.normalizedInputTokens / pctForCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.normalizedOutputTokens / pctForCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.normalizedCacheCreationTokens / pctForCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.normalizedCacheReadTokens / pctForCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-secondary)]">
                            {formatTokens(win.normalizedTotalTokens / pctForCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--accent-green)] border-l border-[var(--border-subtle)]">
                            {formatCost((win.normalizedCost / pctForCost) * 100)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--accent-blue)]">
                            {formatTokens((win.normalizedOutputTokens / pctForCost) * 100)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--accent-cyan)]">
                            {formatTokens((win.normalizedTotalTokens / pctForCost) * 100)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {win.messageCount}
                          </td>
                          <td className="py-1.5 px-2 text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                            {topModels}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              </div>
              <PaginationControls
                page={currentWindowPage}
                pageCount={windowPageCount}
                pageStart={currentWindowStartIndex + 1}
                pageEnd={currentWindowEndIndex}
                totalItems={sortedWindows.length}
                itemLabel="okien"
                onPageChange={setWindowPage}
              />
            </div>
          )}
        </div>
        </>
      )}
    </div>
  );
}
