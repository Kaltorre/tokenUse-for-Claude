"use client";

import { useState } from "react";
import {
  FiveHourWindow,
  DerivedLimits,
  CalibrationPoint,
  SolvedLimits,
  CalibrationScope,
  WeeklyResetConfig,
  PromoPeriod,
  PlanPeriod,
  PLAN_TIERS,
} from "@/lib/types";
import { formatTokens, formatCost } from "@/lib/format";
import {
  calcUtilization,
  BOTTLENECK_LABELS,
  BOTTLENECK_COLORS,
} from "@/lib/utilization";
import {
  getCalibrationForWindow,
  estimateUtilization,
  findCalibrationAnchor,
  findCalibrationSeries,
} from "@/lib/calibration";
import { computeLimitInsight } from "@/lib/limit-insights";
import { getPlanTierForDate } from "@/lib/plans";

interface Props {
  windows: FiveHourWindow[];
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  weeklyResetConfig?: WeeklyResetConfig;
  promoPeriods?: PromoPeriod[];
  planPeriods?: PlanPeriod[];
}

function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatLocalDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pl-PL", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

function formatWeekRange(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function formatGap(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Find the weekly reset anchor (most recent reset point before `date`) */
function findWeekAnchor(
  date: Date,
  config: { day: number; hour: number; minute: number }
): Date {
  const anchor = new Date(date);
  anchor.setUTCHours(config.hour, config.minute, 0, 0);

  const diff = anchor.getUTCDay() - config.day;
  anchor.setUTCDate(anchor.getUTCDate() - diff);

  if (anchor > date) {
    anchor.setUTCDate(anchor.getUTCDate() - 7);
  }

  return anchor;
}

function getWeekKey(date: Date, resetConfig: { day: number; hour: number; minute: number }): string {
  const anchor = findWeekAnchor(date, resetConfig);
  // Compute ISO week from mid-period (anchor + 4 days) to get the "right" week number
  const mid = new Date(anchor.getTime() + 4 * 24 * 60 * 60 * 1000);
  const d = new Date(mid);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum =
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getUTCDay() + 6) % 7)) /
        7
    );
  return `${d.getUTCFullYear()}-W${weekNum.toString().padStart(2, "0")}`;
}

function getWeekStart(date: Date, resetConfig: { day: number; hour: number; minute: number }): Date {
  return findWeekAnchor(date, resetConfig);
}

function getWeekEnd(weekStart: Date): Date {
  return new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
}

type ViewMode = "output" | "total";

interface WindowUtilInfo {
  /** Actual (from calibration) */
  actual: number | null;
  /** Estimated (from solver or derived limits) */
  estimated: number | null;
  /** Delta: observed - estimated */
  delta: number | null;
  /** Is this calibrated (actual) or estimated? */
  isCalibrated: boolean;
  /** Bottleneck indicator */
  bottleneckLabel: string;
  bottleneckColor: string;
  /** Detail breakdown */
  outputPct: number;
  ioPct: number;
  totalPct: number;
}

function getWindowUtil(
  win: FiveHourWindow,
  derivedLimits: DerivedLimits | null,
  calibrations: CalibrationPoint[],
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null,
  promoPeriods: PromoPeriod[] = [],
  planMultiplier: number = 1,
  calibrationSeries: CalibrationPoint[] = [],
  calibrationAnchor?: CalibrationPoint
): WindowUtilInfo | null {
  const cal = getCalibrationForWindow(win.id, calibrations);

  // Try solved limits (calibration-based) first
  let estimated: {
    estimatedPct: number;
    outputPct: number;
    ioPct: number;
    totalPct: number;
    bottleneck: string;
  } | null = null;

  if (solvedLimits && solvedLimits["5h"].best.confidence > 0) {
    const est = estimateUtilization(
      {
        output: win.outputTokens,
        input: win.inputTokens,
        cacheWrite: win.cacheCreationTokens,
        cacheRead: win.cacheReadTokens,
        total: win.totalTokens,
      },
      win.totalCost,
      solvedLimits["5h"],
      win.peakStatus,
      win.startTime,
      win.peakSplit,
      promoPeriods,
      planMultiplier,
      calibrationSeries,
      calibrationAnchor
    );
    if (est) estimated = est;
  }

  // Fallback to derived limits
  if (!estimated && derivedLimits) {
    const util = calcUtilization(
      {
        outputTokens: win.outputTokens,
        inputTokens: win.inputTokens,
        totalTokens: win.totalTokens,
      },
      derivedLimits,
      win.peakStatus,
      win.startTime,
      "5h",
      win.peakSplit,
      promoPeriods,
      planMultiplier
    );
    if (util) {
      estimated = {
        estimatedPct: util.effectivePct,
        outputPct: util.outputPct,
        ioPct: util.inoutPct,
        totalPct: util.totalPct,
        bottleneck: util.bottleneck,
      };
    }
  }

  if (!estimated && !cal) return null;

  const bottleneck = estimated?.bottleneck ?? "output";
  const bLabel = BOTTLENECK_LABELS[bottleneck as keyof typeof BOTTLENECK_LABELS] ?? "?";
  const bColor = BOTTLENECK_COLORS[bottleneck as keyof typeof BOTTLENECK_COLORS] ?? "var(--text-muted)";

  const actualPct = cal?.reportedPct ?? null;
  const estPct = estimated?.estimatedPct ?? null;

  return {
    actual: actualPct,
    estimated: estPct,
    delta: actualPct !== null && estPct !== null ? Math.round((actualPct - estPct) * 10) / 10 : null,
    isCalibrated: cal !== null,
    bottleneckLabel: bLabel,
    bottleneckColor: bColor,
    outputPct: estimated?.outputPct ?? 0,
    ioPct: estimated?.ioPct ?? 0,
    totalPct: estimated?.totalPct ?? 0,
  };
}

interface WeekGroup {
  weekKey: string;
  weekStart: Date;
  weekEnd: Date;
  windows: FiveHourWindow[];
  weekTotalOutput: number;
  weekTotalInput: number;
  weekTotalCacheWrite: number;
  weekTotalCacheRead: number;
  weekTotalTokens: number;
  weekTotalCost: number;
  weekTotalMessages: number;
  weekUtilSum: number;
  weekWindowCount: number;
  calibratedCount: number;
}

function emptyPeakTokens() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    messageCount: 0,
  };
}

function aggregateWeeklyPeakSplit(windows: FiveHourWindow[]): {
  peakStatus: "peak" | "off-peak" | "mixed";
  peakSplit?: NonNullable<FiveHourWindow["peakSplit"]>;
} {
  const peak = emptyPeakTokens();
  const offPeak = emptyPeakTokens();

  const add = (
    target: ReturnType<typeof emptyPeakTokens>,
    source: ReturnType<typeof emptyPeakTokens>
  ) => {
    target.inputTokens += source.inputTokens;
    target.outputTokens += source.outputTokens;
    target.cacheCreationTokens += source.cacheCreationTokens;
    target.cacheReadTokens += source.cacheReadTokens;
    target.totalTokens += source.totalTokens;
    target.totalCost += source.totalCost;
    target.messageCount += source.messageCount;
  };

  for (const win of windows) {
    if (win.peakSplit) {
      add(peak, win.peakSplit.peak);
      add(offPeak, win.peakSplit.offPeak);
      continue;
    }

    const bucket = {
      inputTokens: win.inputTokens,
      outputTokens: win.outputTokens,
      cacheCreationTokens: win.cacheCreationTokens,
      cacheReadTokens: win.cacheReadTokens,
      totalTokens: win.totalTokens,
      totalCost: win.totalCost,
      messageCount: win.messageCount,
    };

    if (win.peakStatus === "off-peak") add(offPeak, bucket);
    else add(peak, bucket);
  }

  if (offPeak.totalTokens === 0) return { peakStatus: "peak" };
  if (peak.totalTokens === 0) return { peakStatus: "off-peak", peakSplit: { peak, offPeak } };
  return { peakStatus: "mixed", peakSplit: { peak, offPeak } };
}

const DEFAULT_RESET = { day: 0, hour: 9, minute: 0 }; // Sunday 9:00 AM

export function FiveHourTimeline({
  windows,
  derivedLimits,
  calibrations,
  solvedLimits,
  weeklyResetConfig,
  promoPeriods = [],
  planPeriods = [],
}: Props) {
  const resetConfig = weeklyResetConfig?.allModels ?? DEFAULT_RESET;
  const [viewMode, setViewMode] = useState<ViewMode>("output");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [weekExpanded, setWeekExpanded] = useState<string | null>(null);

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentWindows = windows
    .filter((w) => new Date(w.startTime).getTime() > sevenDaysAgo)
    .sort(
      (a, b) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );

  // Fallback max for relative bar sizing when no limits are calibrated
  const maxTokens = Math.max(
    ...recentWindows.map((w) =>
      viewMode === "output" ? w.outputTokens : w.totalTokens
    ),
    1
  );

  if (recentWindows.length === 0) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">
          5h Window Timeline
        </h3>
        <p className="text-[var(--text-muted)] text-sm">
          No windows in the last 7 days
        </p>
      </div>
    );
  }

  // Group by week
  const weekGroups: WeekGroup[] = [];
  let currentWeekKey = "";

  for (const win of recentWindows) {
    const winDate = new Date(win.startTime);
    const wk = getWeekKey(winDate, resetConfig);

    if (wk !== currentWeekKey) {
      const ws = getWeekStart(winDate, resetConfig);
      weekGroups.push({
        weekKey: wk,
        weekStart: ws,
        weekEnd: getWeekEnd(ws),
        windows: [],
        weekTotalOutput: 0,
        weekTotalInput: 0,
        weekTotalCacheWrite: 0,
        weekTotalCacheRead: 0,
        weekTotalTokens: 0,
        weekTotalCost: 0,
        weekTotalMessages: 0,
        weekUtilSum: 0,
        weekWindowCount: 0,
        calibratedCount: 0,
      });
      currentWeekKey = wk;
    }

    const group = weekGroups[weekGroups.length - 1];
    group.windows.push(win);
    group.weekTotalOutput += win.outputTokens;
    group.weekTotalInput += win.inputTokens;
    group.weekTotalCacheWrite += win.cacheCreationTokens;
    group.weekTotalCacheRead += win.cacheReadTokens;
    group.weekTotalTokens += win.totalTokens;
    group.weekTotalCost += win.totalCost;
    group.weekTotalMessages += win.messageCount;
    group.weekWindowCount++;

    const winPlanTier = getPlanTierForDate(win.startTime, planPeriods);
    const winPlanMult = (winPlanTier ? PLAN_TIERS[winPlanTier].multiplier : 20) / 20;
    const winAnchor = findCalibrationAnchor(calibrations, "5h", win.startTime);
    const winSeries = findCalibrationSeries(calibrations, "5h", win.startTime);
    const util = getWindowUtil(win, derivedLimits, calibrations, solvedLimits, promoPeriods, winPlanMult, winSeries, winAnchor);
    if (util) {
      group.weekUtilSum += util.actual ?? util.estimated ?? 0;
      if (util.isCalibrated) group.calibratedCount++;
    }
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">
          5h Window Timeline (Last 7 days)
        </h3>
        <div className="flex gap-1 bg-[var(--bg-secondary)] rounded-md p-0.5">
          {(["output", "total"] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`px-2.5 py-1 rounded text-[10px] font-medium transition-all ${
                viewMode === m
                  ? "bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {m === "output" ? "Output" : "Total"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        {weekGroups.map((group) => {
          let lastDateStr = "";

          const weeklySolved = solvedLimits?.["weekly-all"];
          const weekPlanTier = getPlanTierForDate(group.weekStart.toISOString(), planPeriods);
          const weekPlanMult = (weekPlanTier ? PLAN_TIERS[weekPlanTier].multiplier : 20) / 20;
          const weekAnchor = findCalibrationAnchor(calibrations, "weekly-all", group.weekStart.toISOString());
          const weekSeries = findCalibrationSeries(calibrations, "weekly-all", group.weekStart.toISOString());
          const weeklySplit = aggregateWeeklyPeakSplit(group.windows);
          const weeklyInsight = computeLimitInsight({
            scope: "weekly-all",
            usage: {
              outputTokens: group.weekTotalOutput,
              inputTokens: group.weekTotalInput,
              cacheCreationTokens: group.weekTotalCacheWrite,
              cacheReadTokens: group.weekTotalCacheRead,
              totalTokens: group.weekTotalTokens,
              totalCost: group.weekTotalCost,
              peakStatus: weeklySplit.peakStatus,
              peakSplit: weeklySplit.peakSplit,
              windowStart: group.weekStart.toISOString(),
            },
            solvedLimits: solvedLimits ?? null,
            derivedLimits,
            promos: promoPeriods,
            planMultiplier: weekPlanMult,
            calibrationSeries: weekSeries,
            calibrationAnchor: weekAnchor,
            observedPoint: weekAnchor,
          });

          const weeklyPct = weeklyInsight.estimatedPct ?? 0;
          const weeklyBottleneck = weeklyInsight.bottleneck ?? "output";
          const weeklyColor =
            BOTTLENECK_COLORS[weeklyBottleneck as keyof typeof BOTTLENECK_COLORS] ??
            "var(--accent-orange)";

          return (
            <div key={group.weekKey}>
              {/* Week separator */}
              <div className="pt-3 pb-2 px-1 space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex-1 border-t border-[var(--accent-purple)]/30" />
                  <span className="text-[10px] font-medium text-[var(--accent-purple)] uppercase tracking-wider whitespace-nowrap">
                    {group.weekKey} (
                    {formatWeekRange(group.weekStart, group.weekEnd)})
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {group.weekWindowCount} win
                    </span>
                    {group.calibratedCount > 0 && (
                      <span className="text-[10px] text-[var(--accent-green)]">
                        {group.calibratedCount} cal
                      </span>
                    )}
                    <span className="text-[10px] text-[var(--text-secondary)] tabular-nums">
                      {formatTokens(
                        viewMode === "output"
                          ? group.weekTotalOutput
                          : group.weekTotalTokens
                      )}
                    </span>
                  </div>
                  <div className="flex-1 border-t border-[var(--accent-purple)]/30" />
                </div>

                {/* Weekly estimated utilization — thick bar */}
                {weeklyInsight.estimatedPct !== null && weeklyPct > 0 && (
                  <button
                    onClick={() => setWeekExpanded(weekExpanded === group.weekKey ? null : group.weekKey)}
                    className="w-full text-left"
                  >
                    <div className="flex items-center gap-2 px-1 rounded-md hover:bg-[var(--bg-secondary)]/50 transition-colors">
                      <span className="w-24 text-[10px] text-[var(--text-muted)] text-right shrink-0 uppercase tracking-wider">
                        Week est.
                      </span>
                      <div className="flex-1 h-7 bg-[var(--bg-secondary)] rounded overflow-hidden relative">
                        <div
                          className="h-full rounded transition-all duration-300"
                          style={{
                            width: `${Math.max(Math.min(weeklyPct, 100), 2)}%`,
                            background: weeklyColor,
                            opacity: 0.7,
                          }}
                        />
                      </div>
                      <span
                        className="w-32 text-right text-[11px] tabular-nums shrink-0 font-semibold"
                        style={{ color: weeklyColor }}
                        title={
                          weeklyInsight.noPromoPct !== null
                            ? `Est ${weeklyPct.toFixed(1)}% | No promo ${weeklyInsight.noPromoPct.toFixed(1)}%`
                            : `Est ${weeklyPct.toFixed(1)}%`
                        }
                      >
                        {weeklyPct.toFixed(0)}%
                        {weeklyInsight.noPromoPct !== null && (
                          <span className="text-[var(--accent-orange)] ml-1">
                            ({weeklyInsight.noPromoPct.toFixed(0)}%
                            <span className="text-[9px]"> no promo</span>)
                          </span>
                        )}
                        <span className="text-[9px] opacity-70 ml-0.5">
                          {BOTTLENECK_LABELS[weeklyBottleneck as keyof typeof BOTTLENECK_LABELS] ?? ""}
                        </span>
                      </span>
                    </div>

                    {/* Expanded weekly detail */}
                    {weekExpanded === group.weekKey && (
                      <div className="ml-[104px] mt-1 mb-2 p-3 bg-[var(--bg-secondary)] rounded-lg text-xs space-y-1.5">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                          <div className="flex justify-between">
                            <span className="text-[var(--text-muted)]">Input</span>
                            <span className="text-[var(--accent-blue)] tabular-nums">{formatTokens(group.weekTotalInput)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[var(--text-muted)]">Output</span>
                            <span className="text-[var(--accent-green)] tabular-nums">{formatTokens(group.weekTotalOutput)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[var(--text-muted)]">Cache Write</span>
                            <span className="text-[var(--accent-purple)] tabular-nums">{formatTokens(group.weekTotalCacheWrite)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[var(--text-muted)]">Cache Read</span>
                            <span className="text-[var(--accent-cyan)] tabular-nums">{formatTokens(group.weekTotalCacheRead)}</span>
                          </div>
                        </div>

                        {/* Utilization breakdown */}
                        <div className="pt-1.5 border-t border-[var(--border-subtle)]">
                          <div className="grid grid-cols-3 gap-2">
                            {([
                              ["Observed", weeklyInsight.observedPct, "observed"],
                              ["Est", weeklyInsight.estimatedPct, "estimated"],
                              ["No promo", weeklyInsight.noPromoPct, "nopromo"],
                            ] as const).map(([label, val, key]) => (
                              <div key={key} className="text-center">
                                <div className="text-[9px] text-[var(--text-muted)] uppercase">{label}</div>
                                <div
                                  className="text-xs font-medium tabular-nums"
                                  style={{
                                    color: key === "estimated"
                                      ? weeklyColor
                                      : "var(--text-secondary)",
                                  }}
                                >
                                  {val != null ? `${val.toFixed(1)}%` : "—"}
                                  {key === "estimated" && " *"}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="flex justify-between pt-1.5 border-t border-[var(--border-subtle)]">
                          <span className="text-[var(--text-muted)]">
                            {group.weekTotalMessages} msgs / {group.weekWindowCount} windows
                          </span>
                          <span className="text-[var(--text-secondary)] font-medium">
                            {formatTokens(group.weekTotalTokens)} total — {formatCost(group.weekTotalCost)}
                          </span>
                        </div>
                      </div>
                    )}
                  </button>
                )}
              </div>

              {group.windows.map((win, i) => {
                const dateStr = formatLocalDate(win.startTime);
                const showDate = dateStr !== lastDateStr;
                lastDateStr = dateStr;

                const prevWin = group.windows[i - 1];
                const gap = prevWin
                  ? new Date(win.startTime).getTime() -
                    new Date(prevWin.endTime).getTime()
                  : 0;
                const showGap = i > 0 && gap > 0;

                const tokens =
                  viewMode === "output" ? win.outputTokens : win.totalTokens;
                const isExpanded = expanded === win.id;

                const winPlanTier2 = getPlanTierForDate(win.startTime, planPeriods);
                const winPlanMult2 = (winPlanTier2 ? PLAN_TIERS[winPlanTier2].multiplier : 20) / 20;
                const winAnchor2 = findCalibrationAnchor(calibrations, "5h", win.startTime);
                const winSeries2 = findCalibrationSeries(calibrations, "5h", win.startTime);
                const util = getWindowUtil(
                  win,
                  derivedLimits,
                  calibrations,
                  solvedLimits,
                  promoPeriods,
                  winPlanMult2,
                  winSeries2,
                  winAnchor2
                );
                const insight = computeLimitInsight({
                  scope: "5h",
                  usage: {
                    outputTokens: win.outputTokens,
                    inputTokens: win.inputTokens,
                    cacheCreationTokens: win.cacheCreationTokens,
                    cacheReadTokens: win.cacheReadTokens,
                    totalTokens: win.totalTokens,
                    totalCost: win.totalCost,
                    peakStatus: win.peakStatus,
                    peakSplit: win.peakSplit,
                    windowStart: win.startTime,
                  },
                  solvedLimits: solvedLimits ?? null,
                  derivedLimits,
                  promos: promoPeriods,
                  planMultiplier: winPlanMult2,
                  calibrationSeries: winSeries2,
                  calibrationAnchor: winAnchor2,
                  observedPoint: winAnchor2 ?? getCalibrationForWindow(win.id, calibrations),
                });

                // Always show estimated % (reflects current tokens)
                // actual is only for delta comparison
                const displayPct = insight.estimatedPct ?? util?.estimated ?? null;

                // Bar width = % of limit when available, else relative to max window
                const barWidth = displayPct !== null
                  ? Math.min(displayPct, 100)
                  : (tokens / maxTokens) * 100;
                const basePct = insight.noPromoPct;

                return (
                  <div key={win.id}>
                    {showGap && (
                      <div className="flex items-center gap-2 py-1 px-2">
                        <div className="flex-1 border-t border-dashed border-[var(--border-subtle)]" />
                        <span className="text-[10px] text-[var(--text-muted)]">
                          reset — {formatGap(Math.abs(gap))} gap
                        </span>
                        <div className="flex-1 border-t border-dashed border-[var(--border-subtle)]" />
                      </div>
                    )}

                    {showDate && (
                      <div className="text-[10px] text-[var(--text-muted)] font-medium uppercase tracking-wider pt-2 pb-1 px-1">
                        {dateStr}
                      </div>
                    )}

                    <button
                      onClick={() =>
                        setExpanded(isExpanded ? null : win.id)
                      }
                      className="w-full text-left group"
                    >
                      <div className="flex items-center gap-2 py-1.5 px-1 rounded-md hover:bg-[var(--bg-secondary)] transition-colors">
                        {/* Time range */}
                        <span className="w-24 text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
                          {formatLocalTime(win.startTime)}–
                          {formatLocalTime(win.endTime)}
                        </span>

                        {/* Bar */}
                        <div className="flex-1 h-5 bg-[var(--bg-secondary)] rounded overflow-hidden relative">
                          {/* For promo: total bar = base% width, split into effective + bonus */}
                          {basePct !== null && displayPct !== null ? (
                            <>
                              {/* Effective fill (what Claude reports) */}
                              <div
                                className="absolute inset-y-0 left-0 rounded-l transition-all duration-300"
                                style={{
                                  width: `${Math.max(barWidth, 2)}%`,
                                  background:
                                    win.status === "active"
                                      ? "var(--accent-green)"
                                      : "var(--accent-blue)",
                                  opacity: 0.8,
                                }}
                              />
                              {/* Bonus fill (darker, extends from effective% to base%) */}
                              <div
                                className="absolute inset-y-0 rounded-r transition-all duration-300"
                                style={{
                                  left: `${barWidth}%`,
                                  width: `${Math.min(
                                    (basePct ?? 0) - barWidth,
                                    100 - barWidth
                                  )}%`,
                                  background:
                                    win.status === "active"
                                      ? "var(--accent-green)"
                                      : "var(--accent-blue)",
                                  opacity: 0.3,
                                }}
                              />
                            </>
                          ) : (
                            /* Peak / no promo: single bar */
                            <div
                              className="h-full rounded transition-all duration-300"
                              style={{
                                width: `${Math.max(barWidth, 2)}%`,
                                background:
                                  win.status === "active"
                                    ? "var(--accent-green)"
                                    : win.peakStatus === "peak"
                                    ? "var(--accent-red)"
                                    : "var(--accent-blue)",
                                opacity: 0.7,
                              }}
                            />
                          )}
                        </div>

                        {/* Utilization % */}
                        {displayPct !== null && util && (
                          <div
                            className="w-32 text-right text-[11px] tabular-nums shrink-0 font-medium leading-tight"
                            style={{ color: util.bottleneckColor }}
                            title={`OUT ${util.outputPct.toFixed(1)}% | I/O ${util.ioPct.toFixed(1)}% | TOT ${util.totalPct.toFixed(1)}%${basePct ? ` | No promo: ${basePct.toFixed(0)}%` : ""}`}
                          >
                            {basePct !== null ? (
                              /* Promo: show effective / no-promo */
                              <span>
                                {util.isCalibrated && (
                                  <span className="text-[8px] text-[var(--accent-green)] mr-0.5">●</span>
                                )}
                                {displayPct.toFixed(0)}%
                                <span className="text-[var(--accent-orange)] ml-1">
                                  ({basePct.toFixed(0)}%
                                  <span className="text-[9px]"> no promo</span>)
                                </span>
                              </span>
                            ) : (
                              /* No promo: just show % + bottleneck */
                              <span>
                                {util.isCalibrated && (
                                  <span className="text-[8px] text-[var(--accent-green)] mr-0.5">●</span>
                                )}
                                {displayPct.toFixed(0)}%
                                <span className="text-[9px] opacity-70 ml-0.5">
                                  {util.bottleneckLabel}
                                </span>
                              </span>
                            )}
                            {util.delta !== null && (
                              <span
                                className="text-[9px] ml-1"
                                style={{
                                  color:
                                    Math.abs(util.delta) < 2
                                      ? "var(--accent-green)"
                                      : "var(--accent-orange)",
                                }}
                              >
                                {util.delta > 0 ? "+" : ""}
                                {util.delta.toFixed(0)}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Token count */}
                        <span className="w-14 text-right text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">
                          {formatTokens(tokens)}
                        </span>
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="ml-[104px] mt-1 mb-2 p-3 bg-[var(--bg-secondary)] rounded-lg text-xs space-y-1.5">
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                            <div className="flex justify-between">
                              <span className="text-[var(--text-muted)]">
                                Input
                              </span>
                              <span className="text-[var(--accent-blue)] tabular-nums">
                                {formatTokens(win.inputTokens)}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-[var(--text-muted)]">
                                Output
                              </span>
                              <span className="text-[var(--accent-green)] tabular-nums">
                                {formatTokens(win.outputTokens)}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-[var(--text-muted)]">
                                Cache Write
                              </span>
                              <span className="text-[var(--accent-purple)] tabular-nums">
                                {formatTokens(win.cacheCreationTokens)}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-[var(--text-muted)]">
                                Cache Read
                              </span>
                              <span className="text-[var(--accent-cyan)] tabular-nums">
                                {formatTokens(win.cacheReadTokens)}
                              </span>
                            </div>
                          </div>

                          {/* Utilization breakdown */}
                          {util && (
                            <div className="pt-1.5 border-t border-[var(--border-subtle)]">
                              <div className="grid grid-cols-3 gap-2">
                                {(
                                  [
                                    ["Output", util.outputPct, "output"],
                                    ["In+Out", util.ioPct, "inout"],
                                    ["Total", util.totalPct, "total"],
                                  ] as const
                                ).map(([label, val, key]) => (
                                  <div key={key} className="text-center">
                                    <div className="text-[9px] text-[var(--text-muted)] uppercase">
                                      {label}
                                    </div>
                                    <div
                                      className="text-xs font-medium tabular-nums"
                                      style={{
                                        color:
                                          util.bottleneckLabel ===
                                          BOTTLENECK_LABELS[key]
                                            ? util.bottleneckColor
                                            : "var(--text-secondary)",
                                      }}
                                    >
                                      {val.toFixed(1)}%
                                      {util.bottleneckLabel ===
                                        BOTTLENECK_LABELS[key] && " *"}
                                    </div>
                                  </div>
                                ))}
                              </div>

                              {/* Calibration status */}
                              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[var(--border-subtle)]">
                                <span className="text-[10px]">
                                  {util.isCalibrated ? (
                                    <span className="text-[var(--accent-green)]">
                                      ● Calibrated (actual: {util.actual}%)
                                    </span>
                                  ) : (
                                    <span className="text-[var(--text-muted)]">
                                      Estimated (no calibration)
                                    </span>
                                  )}
                                </span>
                                {util.delta !== null && (
                                  <span
                                    className="text-[10px] font-medium"
                                    style={{
                                      color:
                                        Math.abs(util.delta) < 2
                                          ? "var(--accent-green)"
                                          : Math.abs(util.delta) < 5
                                          ? "var(--accent-orange)"
                                          : "var(--accent-red)",
                                    }}
                                  >
                                    Obs - Est: {util.delta > 0 ? "+" : ""}
                                    {util.delta.toFixed(1)}%
                                  </span>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="flex justify-between pt-1.5 border-t border-[var(--border-subtle)]">
                            <span className="text-[var(--text-muted)]">
                              {win.messageCount} msgs /{" "}
                              {win.sessionIds.length} sessions
                            </span>
                            <span className="text-[var(--text-secondary)] font-medium">
                              {formatTokens(win.totalTokens)} total —{" "}
                              {formatCost(win.totalCost)}
                            </span>
                          </div>
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t border-[var(--border-subtle)] justify-center text-[10px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-green)]" />
          Active
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-blue)]" />
          Off-peak
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-red)]" />
          Peak 1x
        </span>
        <span className="border-l border-[var(--border-subtle)] pl-3 flex items-center gap-1">
          <span className="w-3 h-2 rounded-sm bg-[var(--accent-blue)]" style={{ opacity: 0.8 }} />
          <span className="w-3 h-2 rounded-sm bg-[var(--accent-blue)]" style={{ opacity: 0.3 }} />
          Bonus 2x
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[var(--accent-green)]">●</span> Calibrated
        </span>
      </div>
    </div>
  );
}
