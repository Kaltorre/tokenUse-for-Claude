"use client";

import { useMemo, useState } from "react";
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
  outputPct: number;
  inoutPct: number;
  totalPct: number;
  effectivePct: number;
  costPer1Pct: number;
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
  avgOutputTokens: number;
  avgTotalTokens: number;
  totalCost: number;
}

const WEEKLY_CHART_CAP_PCT = 300;

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

export function WeeklyAggregationTab({
  weeklyAll,
  weeklySonnet,
  windows,
  derivedLimits,
  solvedLimits,
  planPeriods = [],
  promoPeriods = [],
}: Props) {
  const [period, setPeriod] = useState<PeriodTab>("week");
  const [scope, setScope] = useState<ModelScope>("all");

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
            const util = calcUtilization(
              {
                outputTokens: bucket.outputTokens,
                inputTokens: bucket.inputTokens,
                totalTokens: bucket.totalTokens,
                totalCost: bucket.totalCost,
              },
              scaledLimits,
              bucket.peakStatus ?? "peak",
              bucket.weekStart,
              "weekly",
              bucket.peakSplit,
              promoPeriods
            );

            // Sessions count: how many full 5h sessions fit in this week
            const scaled5h = buildScaledLimits(fiveHourOnlyLimits, planScale);
            const util5h = calcUtilization(
              {
                outputTokens: bucket.outputTokens,
                inputTokens: bucket.inputTokens,
                totalTokens: bucket.totalTokens,
                totalCost: bucket.totalCost,
              },
              scaled5h,
              bucket.peakStatus ?? "peak",
              bucket.weekStart,
              "5h",
              bucket.peakSplit,
              promoPeriods
            );
            const sessions5h = util5h ? Math.round(util5h.effectivePct / 100 * 10) / 10 : null;

            const outputPct = util?.outputPct ?? 0;
            const inoutPct = util?.inoutPct ?? 0;
            const totalPct = util?.totalPct ?? 0;
            const effectivePct = util?.effectivePct ?? 0;
            const pctForCost = effectivePct > 0 ? effectivePct : 1;

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
              outputPct,
              inoutPct,
              totalPct,
              effectivePct,
              costPer1Pct: bucket.totalCost / pctForCost,
              tokensPer1Pct: bucket.totalTokens / pctForCost,
              inputPer1Pct: bucket.inputTokens / pctForCost,
              outputPer1Pct: bucket.outputTokens / pctForCost,
              cacheCreationPer1Pct: bucket.cacheCreationTokens / pctForCost,
              cacheReadPer1Pct: bucket.cacheReadTokens / pctForCost,
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
          .map((window) =>
            calcUtilization(
              {
                outputTokens: window.outputTokens,
                inputTokens: window.inputTokens,
                totalTokens: window.totalTokens,
                totalCost: window.totalCost,
              },
              scaledLimits,
              window.peakStatus,
              window.startTime,
              "5h",
              window.peakSplit,
              promoPeriods
            )?.effectivePct ?? null
          )
          .filter((value): value is number => value != null);

        const totalOutput = weekWindows.reduce(
          (sum, window) => sum + window.outputTokens,
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

        return {
          weekStart: bucket.weekStart,
          dateRange: formatDateRange(bucket.weekStart, bucket.weekEnd),
          planLabel: weekPlanInfo?.label ?? "Unknown plan",
          planShortLabel: weekPlanInfo?.shortLabel ?? "—",
          planColor: weekPlanInfo?.color ?? "var(--text-muted)",
          windowCount: weekWindows.length,
          avgPct:
            pctValues.length > 0
              ? pctValues.reduce((sum, value) => sum + value, 0) / pctValues.length
              : null,
          avgCost: totalCost / weekWindows.length,
          avgOutputTokens: totalOutput / weekWindows.length,
          avgTotalTokens: totalTokens / weekWindows.length,
          totalCost,
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
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
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
            </div>
            <ScopeTabs value={scope} onChange={setScope} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Cost per 1%
              </div>
              <div className="text-2xl font-semibold text-[var(--accent-green)] tabular-nums">
                {formatCost(latestWeek.costPer1Pct)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                Based on {latestWeek.effectivePct.toFixed(1)}% utilization
              </div>
            </div>
            <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Total Tokens per 1%
              </div>
              <div className="text-2xl font-semibold text-[var(--accent-blue)] tabular-nums">
                {formatTokens(latestWeek.tokensPer1Pct)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                {formatTokens(latestWeek.totalTokens)} total
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
                {latestWeek.messageCount} messages
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">Input / 1%</div>
              <div className="text-sm font-medium text-[var(--accent-blue)] tabular-nums">
                {formatTokens(latestWeek.inputPer1Pct)}
              </div>
            </div>
            <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">Output / 1%</div>
              <div className="text-sm font-medium text-[var(--accent-green)] tabular-nums">
                {formatTokens(latestWeek.outputPer1Pct)}
              </div>
            </div>
            <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">
                Cache Write / 1%
              </div>
              <div className="text-sm font-medium text-[var(--accent-purple)] tabular-nums">
                {formatTokens(latestWeek.cacheCreationPer1Pct)}
              </div>
            </div>
            <div className="p-3 bg-[var(--bg-secondary)] rounded-lg">
              <div className="text-[9px] text-[var(--text-muted)] uppercase mb-1">
                Cache Read / 1%
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
              Osobny widok dla ALL models i SONNET only.
            </p>
          </div>
          <ScopeTabs value={scope} onChange={setScope} />
        </div>

        {selectedRows.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Brak danych dla tego widoku.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)]">
                <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Week</th>
                <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Plan</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium" title="Estimated weekly utilization (from calibration)">
                  {hasWeeklyLimits ? "W%" : "%"}
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium" title="Full 5h sessions equivalent">
                  ×5h
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Cost</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  $/1%
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  Tokens
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">In</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  Out
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  CacheW
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  CacheR
                </th>
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
                    <td className="py-2 px-2 text-[var(--text-secondary)]">{week.dateRange}</td>
                    <td className="py-2 px-2">
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold"
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
                      className="py-2 px-2 text-right tabular-nums font-medium"
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
                    <td className="py-2 px-2 text-right tabular-nums text-[var(--accent-purple)]">
                      {week.sessions5h != null ? `${week.sessions5h.toFixed(1)}×` : "—"}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-[var(--accent-green)]">
                      {formatCost(week.totalCost)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                      {formatCost(week.costPer1Pct)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-[var(--accent-blue)]">
                      {formatTokens(week.totalTokens)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                      {formatTokens(week.inputTokens)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                      {formatTokens(week.outputTokens)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                      {formatTokens(week.cacheCreationTokens)}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                      {formatTokens(week.cacheReadTokens)}
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
          Średnia na jedno okno 5h wewnątrz tygodnia, z tym samym oznaczeniem planu.
        </p>

        {fiveHourAverageRows.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Brak danych 5h.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)]">
                <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Week</th>
                <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Plan</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  Avg 5h %
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  Avg Cost
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  Avg Output
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  Avg Total
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  Windows
                </th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">
                  Week Cost
                </th>
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
                  <td className="py-2 px-2 text-[var(--text-secondary)]">{week.dateRange}</td>
                  <td className="py-2 px-2">
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold"
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
                    className="py-2 px-2 text-right tabular-nums font-medium"
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
                  <td className="py-2 px-2 text-right tabular-nums text-[var(--accent-green)]">
                    {formatCost(week.avgCost)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-[var(--accent-blue)]">
                    {formatTokens(week.avgOutputTokens)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-[var(--text-secondary)]">
                    {formatTokens(week.avgTotalTokens)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                    {week.windowCount}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-[var(--accent-purple)]">
                    {formatCost(week.totalCost)}
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
              const scaledLimits = buildScaledLimits(effectiveLimits, 1);
              const util = calcUtilization(
                { outputTokens: win.outputTokens, inputTokens: win.inputTokens, totalTokens: win.totalTokens, totalCost: win.totalCost },
                scaledLimits, win.peakStatus, win.startTime, "5h", win.peakSplit, promoPeriods
              );
              return {
                name: new Date(win.startTime).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
                pct: Math.min(util?.effectivePct ?? 0, 150),
                rawPct: util?.effectivePct ?? 0,
                cost: win.totalCost,
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
                      formatter={(value: number, _name: string, item: { payload?: { rawPct?: number; cost?: number; peak?: boolean } }) => [
                        `${(item?.payload?.rawPct ?? value).toFixed(1)}% · ${formatCost(item?.payload?.cost ?? 0)}${item?.payload?.peak ? " (peak)" : ""}`,
                        "5h window",
                      ]}
                    />
                    <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
                      {winChartData.map((entry, index) => (
                        <Cell key={`wincell-${index}`} fill={entry.color} opacity={0.75} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            );
          })()}
        </div>

        <div className="card p-5">
          <div className="mb-4">
            <h3 className="text-sm font-medium text-[var(--text-secondary)]">
              5h Window Breakdown
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Poszczególne okna 5-godzinne z metrykami % i kosztu.
            </p>
          </div>

          {windows.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Brak danych okien 5h.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Window</th>
                    <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Peak</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">%</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Cost</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Tokens</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Out</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">In</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">CacheR</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">CacheW</th>
                    <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Msgs</th>
                    <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Models</th>
                  </tr>
                </thead>
                <tbody>
                  {[...windows]
                    .sort((a, b) => b.startTime.localeCompare(a.startTime))
                    .slice(0, 100)
                    .map((win) => {
                      const scaledLimits = buildScaledLimits(effectiveLimits, 1);
                      const util = calcUtilization(
                        {
                          outputTokens: win.outputTokens,
                          inputTokens: win.inputTokens,
                          totalTokens: win.totalTokens,
                          totalCost: win.totalCost,
                        },
                        scaledLimits,
                        win.peakStatus,
                        win.startTime,
                        "5h",
                        win.peakSplit,
                        promoPeriods
                      );
                      const pct = util?.effectivePct ?? 0;
                      const topModels = Object.entries(win.models)
                        .sort((a, b) => b[1].totalCost - a[1].totalCost)
                        .slice(0, 3)
                        .map(([name, stats]) => `${name}(${stats.messageCount})`)
                        .join(", ");

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
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--accent-green)]">
                            {formatCost(win.totalCost)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-secondary)]">
                            {formatTokens(win.totalTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.outputTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.inputTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.cacheReadTokens)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {formatTokens(win.cacheCreationTokens)}
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
          )}
        </div>
        </>
      )}
    </div>
  );
}
