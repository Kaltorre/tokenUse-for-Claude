"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  CalibrationPoint,
  CalibrationScope,
  EstimationMethod,
  FiveHourWindow,
  PlanPeriod,
  PlanTier,
  PLAN_TIERS,
  WeeklyBucket,
  SolvedLimits,
  PlanLimits,
  LimitOverridesMap,
  LimitOverrideEntry,
  getDefaultLimits,
} from "@/lib/types";
import { LimitSourceMode } from "@/lib/limit-source";
import type { AnomalyTag, AnomalyFlag } from "@/lib/types";
import { formatTokens, formatCost } from "@/lib/format";
import {
  buildPerPercentMetrics,
  CalibrationPerPercentMetricKey,
  CalibrationPerPercentPoint,
} from "@/lib/calibration";
import { getPlanForDate } from "@/lib/plans";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Props {
  currentWindow: FiveHourWindow | null;
  currentWeekAll: WeeklyBucket | null;
  currentWeekSonnet: WeeklyBucket | null;
  calibrations: CalibrationPoint[];
  solvedLimits: Record<CalibrationScope, SolvedLimits>;
  onCalibrationChange: () => void | Promise<void>;
  planPeriods?: PlanPeriod[];
  limitOverrides?: LimitOverridesMap;
  onLimitOverridesChange?: () => void | Promise<void>;
  limitSourceMode: LimitSourceMode;
  onLimitSourceModeChange: (mode: LimitSourceMode) => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("pl-PL", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color =
    confidence >= 0.7
      ? "var(--accent-green)"
      : confidence >= 0.4
      ? "var(--accent-orange)"
      : "var(--accent-red)";
  return (
    <span
      className="text-[10px] font-medium px-1.5 py-0.5 rounded"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      {(confidence * 100).toFixed(0)}% conf
    </span>
  );
}

function SolvedDisplay({ solved }: { solved: SolvedLimits }) {
  if (solved.methods.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="p-3 bg-[var(--bg-primary)] rounded-lg border border-[var(--accent-blue)]/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-medium text-[var(--accent-blue)] uppercase tracking-wider">
            Best Estimate ({solved.scope})
          </span>
          <ConfidenceBadge confidence={solved.best.confidence} />
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <div className="text-[var(--text-muted)] text-[10px]">Output</div>
            <div className="text-[var(--accent-green)] font-medium tabular-nums">
              {formatTokens(solved.best.outputLimit)}
            </div>
          </div>
          <div>
            <div className="text-[var(--text-muted)] text-[10px]">In+Out</div>
            <div className="text-[var(--accent-blue)] font-medium tabular-nums">
              {formatTokens(solved.best.inputOutputLimit)}
            </div>
          </div>
          <div>
            <div className="text-[var(--text-muted)] text-[10px]">Total</div>
            <div className="text-[var(--accent-cyan)] font-medium tabular-nums">
              {formatTokens(solved.best.totalLimit)}
            </div>
          </div>
        </div>
        {solved.best.costLimit > 0 && (
          <div className="mt-2 text-[10px] text-[var(--text-muted)]">
            Cost limit: ~{formatCost(solved.best.costLimit)} per window
          </div>
        )}
      </div>

      <div className="space-y-1">
        {solved.methods.map((m) => (
          <div
            key={m.method}
            className="flex items-center justify-between p-2 bg-[var(--bg-secondary)] rounded text-[10px]"
          >
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-secondary)] font-medium uppercase w-16">
                {m.method}
              </span>
              <span className="text-[var(--text-muted)]">
                {m.dataPoints} pts
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[var(--text-muted)] tabular-nums">
                OUT {formatTokens(m.outputLimit)}
              </span>
              <span className="text-[var(--text-muted)] tabular-nums">
                I/O {formatTokens(m.inputOutputLimit)}
              </span>
              <span className="text-[var(--text-muted)] tabular-nums">
                TOT {formatTokens(m.totalLimit)}
              </span>
              <ConfidenceBadge confidence={m.confidence} />
            </div>
          </div>
        ))}
      </div>

      {solved.weights && (
        <div className="p-2 bg-[var(--bg-secondary)] rounded text-[10px] text-[var(--text-muted)]">
          <span className="font-medium text-[var(--text-secondary)]">
            Token weights (vs output=1.0):
          </span>{" "}
          input={solved.weights.input.toFixed(3)}, cache_write=
          {solved.weights.cacheWrite.toFixed(3)}, cache_read=
          {solved.weights.cacheRead.toFixed(3)}
        </div>
      )}
    </div>
  );
}

/** Group calibration points by timestamp (within 2min = same observation) */
function groupByObservation(calibrations: CalibrationPoint[]) {
  const sorted = [...calibrations].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const groups: {
    timestamp: string;
    points: Partial<Record<CalibrationScope, CalibrationPoint>>;
  }[] = [];

  for (const p of sorted) {
    const t = new Date(p.timestamp).getTime();
    const existing = groups.find(
      (g) => Math.abs(new Date(g.timestamp).getTime() - t) < 2 * 60 * 1000
    );
    if (existing) {
      existing.points[p.scope] = p;
    } else {
      groups.push({ timestamp: p.timestamp, points: { [p.scope]: p } });
    }
  }

  return groups;
}

type AnalyticsPoint = CalibrationPerPercentPoint & {
  planTier: PlanTier | null;
  planLabel: string;
};

type PlanFilter = "all" | PlanTier;

const METRIC_META: Record<
  CalibrationPerPercentMetricKey,
  {
    label: string;
    short: string;
    color: string;
    formatter: (value: number) => string;
  }
> = {
  costPerPct: {
    label: "Full Cost / 1%",
    short: "Cost",
    color: "var(--accent-orange)",
    formatter: formatCost,
  },
  outputPerPct: {
    label: "Output / 1%",
    short: "Out",
    color: "var(--accent-green)",
    formatter: formatTokens,
  },
  inputPerPct: {
    label: "Input / 1%",
    short: "In",
    color: "var(--accent-blue)",
    formatter: formatTokens,
  },
  ioPerPct: {
    label: "Input+Output / 1%",
    short: "I/O",
    color: "var(--accent-cyan)",
    formatter: formatTokens,
  },
  cacheWritePerPct: {
    label: "Cache Write / 1%",
    short: "CW",
    color: "var(--accent-purple)",
    formatter: formatTokens,
  },
  cacheReadPerPct: {
    label: "Cache Read / 1%",
    short: "CR",
    color: "var(--accent-cyan)",
    formatter: formatTokens,
  },
  totalPerPct: {
    label: "Total / 1%",
    short: "Total",
    color: "var(--accent-red)",
    formatter: formatTokens,
  },
};

function medianOfNumbers(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatMetricValue(
  metric: CalibrationPerPercentMetricKey,
  value: number | null
): string {
  if (value == null || !isFinite(value)) return "—";
  return METRIC_META[metric].formatter(value);
}

function formatImpliedCapacity(
  metric: CalibrationPerPercentMetricKey,
  value: number | null
): string {
  if (value == null || !isFinite(value)) return "—";
  return METRIC_META[metric].formatter(value * 100);
}

function formatPlanLabel(planTier: PlanTier | null): string {
  return planTier ? PLAN_TIERS[planTier].shortLabel : "—";
}

function formatChartTime(iso: string): string {
  return new Date(iso).toLocaleString("pl-PL", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PerPercentAnalyticsPanel({
  calibrations,
  planPeriods = [],
}: {
  calibrations: CalibrationPoint[];
  planPeriods?: PlanPeriod[];
}) {
  const [selectedScope, setSelectedScope] =
    useState<CalibrationScope>("weekly-all");
  const [selectedMetric, setSelectedMetric] =
    useState<CalibrationPerPercentMetricKey>("costPerPct");
  const [selectedPlan, setSelectedPlan] = useState<PlanFilter>("all");

  const analyticsPoints = useMemo<AnalyticsPoint[]>(() => {
    return buildPerPercentMetrics(calibrations).map((point) => {
      const plan =
        planPeriods.length > 0
          ? getPlanForDate(point.windowStart ?? point.timestamp, planPeriods)
          : null;
      return {
        ...point,
        planTier: plan?.tier ?? null,
        planLabel: formatPlanLabel(plan?.tier ?? null),
      };
    });
  }, [calibrations, planPeriods]);

  const availablePlans = useMemo(
    () =>
      [...new Set(analyticsPoints.map((point) => point.planTier).filter(Boolean))] as PlanTier[],
    [analyticsPoints]
  );

  const filteredPoints = useMemo(() => {
    return analyticsPoints.filter((point) => {
      if (point.scope !== selectedScope) return false;
      if (selectedPlan !== "all" && point.planTier !== selectedPlan) return false;
      return true;
    });
  }, [analyticsPoints, selectedPlan, selectedScope]);

  const chartPoints = useMemo(() => {
    return filteredPoints
      .filter((point) => point[selectedMetric] != null)
      .map((point, index) => ({
        id: point.id,
        order: index + 1,
        label: formatChartTime(point.timestamp),
        value: point[selectedMetric] as number,
        reportedPct: point.reportedPct,
        planLabel: point.planLabel,
        anomalyStatus: point.anomalyStatus,
      }));
  }, [filteredPoints, selectedMetric]);

  const baselinePoint = chartPoints.length > 0 ? chartPoints[0] : null;
  const latestPoint =
    chartPoints.length > 0 ? chartPoints[chartPoints.length - 1] : null;
  const chartMedian = medianOfNumbers(chartPoints.map((point) => point.value));
  const changePct =
    baselinePoint && latestPoint && baselinePoint.value > 0
      ? ((latestPoint.value - baselinePoint.value) / baselinePoint.value) * 100
      : null;

  const renderDot = (props: {
    cx?: number;
    cy?: number;
    index?: number;
    payload?: { anomalyStatus?: string };
  }) => {
    const { cx, cy, payload, index } = props;
    if (cx == null || cy == null) {
      return <circle key={`dot-empty-${index}`} cx={0} cy={0} r={0} fill="transparent" />;
    }
    const fill =
      payload?.anomalyStatus === "excluded"
        ? "var(--accent-red)"
        : payload?.anomalyStatus === "flagged"
        ? "var(--accent-orange)"
        : METRIC_META[selectedMetric].color;
    return <circle key={`dot-${index}`} cx={cx} cy={cy} r={4} fill={fill} stroke="var(--bg-card)" strokeWidth={2} />;
  };

  return (
    <div className="card p-4 space-y-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="text-sm font-medium text-[var(--text-secondary)]">
            Normalized Capacity per 1%
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            Każdy punkt liczony do Normal: promo jest zdejmowane do bazowej pojemności 100%.
          </div>
        </div>
        <div className="text-[10px] text-[var(--text-muted)]">
          {filteredPoints.length} pts in view
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
            Scope
          </div>
          <div className="flex flex-wrap gap-1">
            {([
              ["5h", "Session"],
              ["weekly-all", "Weekly All"],
              ["weekly-sonnet", "Weekly Sonnet"],
            ] as [CalibrationScope, string][]).map(([scope, label]) => (
              <button
                key={scope}
                onClick={() => setSelectedScope(scope)}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                  selectedScope === scope
                    ? "bg-[var(--accent-blue)] text-white"
                    : "bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
            Plan
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setSelectedPlan("all")}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                selectedPlan === "all"
                  ? "bg-[var(--accent-blue)] text-white"
                  : "bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              All plans
            </button>
            {availablePlans.map((planTier) => (
              <button
                key={planTier}
                onClick={() => setSelectedPlan(planTier)}
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                  selectedPlan === planTier
                    ? "bg-[var(--accent-blue)] text-white"
                    : "bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {PLAN_TIERS[planTier].shortLabel}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
            Metric
          </div>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(METRIC_META) as CalibrationPerPercentMetricKey[]).map(
              (metric) => (
                <button
                  key={metric}
                  onClick={() => setSelectedMetric(metric)}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                    selectedMetric === metric
                      ? "text-white"
                      : "bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                  }`}
                  style={
                    selectedMetric === metric
                      ? { background: METRIC_META[metric].color }
                      : undefined
                  }
                >
                  {METRIC_META[metric].short}
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {chartPoints.length === 0 ? (
        <div className="p-4 rounded-lg bg-[var(--bg-secondary)] text-sm text-[var(--text-muted)] text-center">
          Brak punktów z poprawnym `%` dla wybranego scope/plan.
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="p-3 rounded-lg bg-[var(--bg-secondary)]">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                Latest {METRIC_META[selectedMetric].short}
              </div>
              <div
                className="text-lg font-semibold tabular-nums"
                style={{ color: METRIC_META[selectedMetric].color }}
              >
                {formatMetricValue(selectedMetric, latestPoint?.value ?? null)}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mt-1">
                Implied Normal 100%:{" "}
                {formatImpliedCapacity(selectedMetric, latestPoint?.value ?? null)}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[var(--bg-secondary)]">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                Baseline
              </div>
              <div className="text-lg font-semibold text-[var(--text-secondary)] tabular-nums">
                {formatMetricValue(selectedMetric, baselinePoint?.value ?? null)}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mt-1">
                {baselinePoint?.label ?? "—"}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[var(--bg-secondary)]">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                Delta vs baseline
              </div>
              <div
                className={`text-lg font-semibold tabular-nums ${
                  changePct != null && changePct < 0
                    ? "text-[var(--accent-red)]"
                    : "text-[var(--accent-green)]"
                }`}
              >
                {changePct == null ? "—" : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%`}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mt-1">
                Median: {formatMetricValue(selectedMetric, chartMedian)}
              </div>
            </div>
          </div>

          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartPoints}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border-subtle)"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  axisLine={{ stroke: "var(--border-subtle)" }}
                  tickLine={false}
                  minTickGap={32}
                />
                <YAxis
                  tickFormatter={(value: number) =>
                    formatMetricValue(selectedMetric, value)
                  }
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={70}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value: number) => [
                    formatMetricValue(selectedMetric, value),
                    METRIC_META[selectedMetric].label,
                  ]}
                  labelFormatter={(label, payload) => {
                    const point = payload?.[0]?.payload as
                      | {
                          reportedPct?: number;
                          planLabel?: string;
                        }
                      | undefined;
                    if (!point) return label;
                    return `${label} · ${point.planLabel ?? "—"} · ${point.reportedPct ?? "—"}%`;
                  }}
                />
                {chartMedian != null && (
                  <ReferenceLine
                    y={chartMedian}
                    stroke="var(--text-muted)"
                    strokeDasharray="4 4"
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={METRIC_META[selectedMetric].color}
                  strokeWidth={2}
                  dot={renderDot}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="flex gap-4 text-[10px] text-[var(--text-muted)]">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: METRIC_META[selectedMetric].color }} />
              normal
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[var(--accent-orange)]" />
              flagged
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[var(--accent-red)]" />
              excluded
            </span>
          </div>
        </>
      )}

      <div className="overflow-x-auto border border-[var(--border-subtle)] rounded-lg">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <th className="text-left py-2 px-3 text-[var(--text-muted)] uppercase tracking-wider font-medium">
                Time
              </th>
              <th className="text-left py-2 px-3 text-[var(--text-muted)] uppercase tracking-wider font-medium">
                Plan
              </th>
              <th className="text-right py-2 px-3 text-[var(--text-muted)] uppercase tracking-wider font-medium">
                %
              </th>
              <th className="text-right py-2 px-3 text-[var(--text-muted)] uppercase tracking-wider font-medium">
                Promo
              </th>
              {(Object.keys(METRIC_META) as CalibrationPerPercentMetricKey[]).map(
                (metric) => (
                  <th
                    key={metric}
                    className="text-right py-2 px-3 uppercase tracking-wider font-medium"
                    style={{ color: METRIC_META[metric].color }}
                  >
                    {METRIC_META[metric].short} / 1%
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {[...filteredPoints]
              .sort(
                (a, b) =>
                  new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
              )
              .map((point) => (
                <tr
                  key={point.id}
                  className="border-b border-[var(--border-subtle)]/50 hover:bg-[var(--bg-secondary)]"
                >
                  <td className="py-2 px-3 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {point.anomalyStatus === "flagged" && (
                        <span className="text-yellow-400">⚠</span>
                      )}
                      {point.anomalyStatus === "excluded" && (
                        <span className="text-red-400">✕</span>
                      )}
                      <span className="text-[var(--text-secondary)]">
                        {formatTime(point.timestamp)}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 px-3 text-[var(--text-muted)]">
                    {point.planLabel}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-[var(--text-secondary)]">
                    {point.reportedPct}%
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-[var(--text-muted)]">
                    {point.peakStatus}
                  </td>
                  {(Object.keys(METRIC_META) as CalibrationPerPercentMetricKey[]).map(
                    (metric) => (
                      <td
                        key={metric}
                        className="py-2 px-3 text-right tabular-nums text-[var(--text-secondary)]"
                      >
                        {formatMetricValue(metric, point[metric])}
                      </td>
                    )
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Add / Edit Calibration Dialog ────────────────────────────────────────────

interface CalibrationDialogInitial {
  pctSession?: number;
  pctWeeklyAll?: number;
  pctWeeklySonnet?: number;
  observedAt: string;
}

interface CalibrationDialogProps {
  initial?: CalibrationDialogInitial;
  onSave: (
    pctSession: number | null,
    pctWeeklyAll: number | null,
    pctWeeklySonnet: number | null,
    observedAt: string,
    onStatus?: (message: string) => void
  ) => Promise<void>;
  onClose: () => void;
}

function CalibrationDialog({ initial, onSave, onClose }: CalibrationDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [pctSession, setPctSession] = useState(initial?.pctSession != null ? String(initial.pctSession) : "");
  const [pctWeeklyAll, setPctWeeklyAll] = useState(initial?.pctWeeklyAll != null ? String(initial.pctWeeklyAll) : "");
  const [pctWeeklySonnet, setPctWeeklySonnet] = useState(initial?.pctWeeklySonnet != null ? String(initial.pctWeeklySonnet) : "");
  const [observedAt, setObservedAt] = useState(initial ? toDatetimeLocal(new Date(initial.observedAt)) : toDatetimeLocal(new Date()));
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const parseOpt = (v: string) => {
    const n = parseFloat(v);
    return v.trim() !== "" && !isNaN(n) && n >= 0 && n <= 100 ? n : null;
  };

  const hasAnyValue =
    parseOpt(pctSession) !== null ||
    parseOpt(pctWeeklyAll) !== null ||
    parseOpt(pctWeeklySonnet) !== null;

  const handleSave = async () => {
    if (!hasAnyValue) return;
    setSaving(true);
    setSaveError(null);
    setSaveStatus(initial ? "Updating calibration..." : "Saving calibration...");
    try {
      await onSave(
        parseOpt(pctSession),
        parseOpt(pctWeeklyAll),
        parseOpt(pctWeeklySonnet),
        new Date(observedAt).toISOString(),
        setSaveStatus,
      );
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save calibration");
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors tabular-nums";

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="card p-5 w-full max-w-sm mx-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
          {initial ? "Edit Calibration Point" : "Add Calibration Point"}
        </h3>

        <div className="space-y-3 mb-5">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              When did Claude show these values?
            </label>
            <input
              type="datetime-local"
              value={observedAt}
              onChange={(e) => setObservedAt(e.target.value)}
              disabled={saving}
              style={{ colorScheme: "dark" }}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--accent-blue)" }}>
                Session %
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={pctSession}
                  onChange={(e) => setPctSession(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  disabled={saving}
                  placeholder="10"
                  className={inputClass}
                />
                <span className="text-xs text-[var(--text-muted)]">%</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--accent-purple)" }}>
                Weekly All %
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={pctWeeklyAll}
                  onChange={(e) => setPctWeeklyAll(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  disabled={saving}
                  placeholder="2"
                  className={inputClass}
                />
                <span className="text-xs text-[var(--text-muted)]">%</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--accent-green)" }}>
                Weekly Sonnet %
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={pctWeeklySonnet}
                  onChange={(e) => setPctWeeklySonnet(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  disabled={saving}
                  placeholder="0"
                  className={inputClass}
                />
                <span className="text-xs text-[var(--text-muted)]">%</span>
              </div>
            </div>
          </div>
        </div>

        {saving && (
          <div className="mb-4">
            <div className="h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
              <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-[var(--accent-blue)] to-transparent rounded-full animate-[shimmer_1.5s_ease-in-out_infinite]" />
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mt-2">
              {saveStatus ?? "Saving calibration..."}
            </p>
          </div>
        )}

        {saveError && (
          <p className="text-[11px] text-[var(--accent-red)] mb-4">
            {saveError}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasAnyValue || saving}
            className="px-4 py-2 text-xs font-medium bg-[var(--accent-blue)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving..." : initial ? "Update" : "Calibrate"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Anomaly Flag Panel ────────────────────────────────────────────────────────

interface AnomalyFlagPanelProps {
  point: CalibrationPoint;
  onPatch: (flag: AnomalyFlag) => void;
  onClose: () => void;
}

function AnomalyFlagPanel({ point, onPatch, onClose }: AnomalyFlagPanelProps) {
  const [tag, setTag] = useState<AnomalyTag | ''>(point.anomalyFlag?.tag ?? '');
  const [note, setNote] = useState(point.anomalyFlag?.note ?? '');
  const currentStatus = point.anomalyFlag?.status ?? 'normal';

  const TAG_OPTIONS: { value: AnomalyTag | ''; label: string }[] = [
    { value: '', label: '— wybierz tag —' },
    { value: 'data-entry-error', label: 'błąd wpisu' },
    { value: 'unknown-promo', label: 'nieznana promo' },
    { value: 'genuine-limit-change', label: 'prawdziwa zmiana limitu' },
  ];

  const baseFlag = {
    source: 'reviewed' as const,
    tag: (tag as AnomalyTag) || undefined,
    note: note || undefined,
    detectedAt: point.anomalyFlag?.detectedAt,
  };

  return (
    <div className="mt-1 p-2 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded text-left text-[10px] space-y-1.5" style={{ minWidth: 180 }}>
      <select
        value={tag}
        onChange={(e) => setTag(e.target.value as AnomalyTag | '')}
        className="w-full bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded px-1.5 py-1 text-[10px] text-[var(--text-primary)]"
      >
        {TAG_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <input
        type="text"
        placeholder="Notatka (opcjonalnie)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="w-full bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded px-1.5 py-1 text-[10px] text-[var(--text-primary)]"
      />
      <div className="flex gap-1 flex-wrap pt-0.5">
        <button
          onClick={() => { onPatch({ ...baseFlag, status: currentStatus }); onClose(); }}
          className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          Zapisz
        </button>
        {currentStatus !== 'excluded' && (
          <button
            onClick={() => { onPatch({ ...baseFlag, status: 'excluded' }); onClose(); }}
            className="px-2 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 hover:bg-red-500/20"
          >
            Wyklucz
          </button>
        )}
        {currentStatus !== 'normal' && (
          <button
            onClick={() => { onPatch({ status: 'normal', source: 'reviewed' }); onClose(); }}
            className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          >
            Przywróć
          </button>
        )}
        <button
          onClick={onClose}
          className="ml-auto px-2 py-0.5 text-[10px] text-[var(--text-muted)]"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Calibrated Plan Limits Table (editable) ─────────────────────────────────

const PLAN_TIER_KEYS: PlanTier[] = ["max20", "max5", "team", "pro"];

function calibratedPlanLimits(
  solved: SolvedLimits,
  tier: PlanTier
): PlanLimits | null {
  if (solved.methods.length === 0 || solved.best.confidence <= 0) return null;
  const m = PLAN_TIERS[tier].multiplier;
  const base = 20; // Max $200 multiplier
  return {
    outputLimit: Math.round((solved.best.outputLimit / base) * m),
    inputOutputLimit: Math.round((solved.best.inputOutputLimit / base) * m),
    totalLimit: Math.round((solved.best.totalLimit / base) * m),
    costLimit: Math.round(((solved.best.costLimit / base) * m) * 100) / 100,
  };
}

/** Get plan limits using a specific estimation method */
function calibratedPlanLimitsByMethod(
  solved: SolvedLimits,
  tier: PlanTier,
  method: EstimationMethod
): PlanLimits | null {
  const entry = solved.methods.find((m) => m.method === method);
  if (!entry || entry.confidence <= 0) return null;
  const m = PLAN_TIERS[tier].multiplier;
  const base = 20;
  return {
    outputLimit: Math.round((entry.outputLimit / base) * m),
    inputOutputLimit: Math.round((entry.inputOutputLimit / base) * m),
    totalLimit: Math.round((entry.totalLimit / base) * m),
    costLimit: Math.round(((entry.costLimit / base) * m) * 100) / 100,
  };
}

type LimitField = "costLimit" | "outputLimit" | "inputOutputLimit" | "totalLimit";

function EditableCell({
  value,
  overrideValue,
  field,
  overrideKey,
  isCost,
  color,
  bold,
  onSave,
}: {
  value: number;
  overrideValue: number | null | undefined;
  field: LimitField;
  overrideKey: string;
  isCost?: boolean;
  color?: string;
  bold?: boolean;
  onSave: (key: string, field: LimitField, val: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const hasOverride = overrideValue != null;
  const displayValue = hasOverride ? overrideValue : value;

  const startEdit = () => {
    setEditVal(isCost ? displayValue.toFixed(2) : String(displayValue));
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const parsed = parseFloat(editVal);
    if (isNaN(parsed) || parsed < 0) return;
    // If same as calculated value, remove override
    const rounded = isCost ? Math.round(parsed * 100) / 100 : Math.round(parsed);
    if (Math.abs(rounded - value) < 0.01) {
      if (hasOverride) onSave(overrideKey, field, null); // remove override
    } else {
      onSave(overrideKey, field, rounded);
    }
  };

  const cancelEdit = () => setEditing(false);

  if (editing) {
    return (
      <td className="py-0.5 px-1">
        <input
          type="number"
          value={editVal}
          onChange={(e) => setEditVal(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") cancelEdit();
          }}
          autoFocus
          step={isCost ? "0.01" : "1000"}
          className="w-full bg-[var(--bg-primary)] border-2 border-[var(--accent-blue)] rounded px-1.5 py-1 text-[11px] text-right tabular-nums text-[var(--text-primary)] focus:outline-none"
        />
      </td>
    );
  }

  return (
    <td
      className={`py-1.5 px-2 text-right tabular-nums cursor-pointer group/cell transition-colors ${bold ? "font-semibold" : ""}`}
      style={{ color: color ?? "var(--text-secondary)" }}
      onClick={startEdit}
      title="Kliknij aby edytować"
    >
      <span className="inline-flex items-center gap-1 rounded px-1 -mx-1 py-0.5 group-hover/cell:bg-[var(--accent-blue)]/10 transition-colors">
        <span className={hasOverride ? "border-b-2 border-dashed border-[var(--accent-blue)]" : ""}>
          {isCost ? formatCost(displayValue) : formatTokens(displayValue)}
        </span>
        <svg className="w-3 h-3 opacity-0 group-hover/cell:opacity-60 transition-opacity shrink-0" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.1 1.3a1 1 0 0 1 1.4 0l1.2 1.2a1 1 0 0 1 0 1.4l-8.5 8.5-3.2.8.8-3.2 8.3-8.7zm.7.7L4.5 10.3l-.4 1.6 1.6-.4L14 3.2 12.8 2z"/>
        </svg>
      </span>
    </td>
  );
}

type CalibrationSource = "off" | "best" | "cost" | "direct";

const CALIBRATION_SOURCES: { key: CalibrationSource; label: string; shortLabel: string; color: string; description: string }[] = [
  { key: "off", label: "OFF", shortLabel: "OFF", color: "var(--text-muted)", description: "Domyślne hardcoded" },
  { key: "best", label: "Best", shortLabel: "Best", color: "var(--accent-green)", description: "Ensemble (wszystkie metody)" },
  { key: "cost", label: "USD", shortLabel: "$", color: "var(--accent-orange)", description: "Kalibracja z kosztu ($)" },
  { key: "direct", label: "5h", shortLabel: "5h", color: "var(--accent-blue)", description: "Kalibracja z tokenów" },
];

function CalibratedPlanLimitsTable({
  solvedLimits,
  overrides,
  onOverrideChange,
  limitSourceMode,
  onLimitSourceModeChange,
}: {
  solvedLimits: Record<CalibrationScope, SolvedLimits>;
  overrides: LimitOverridesMap;
  onOverrideChange: () => void;
  limitSourceMode: LimitSourceMode;
  onLimitSourceModeChange: (mode: LimitSourceMode) => void;
}) {
  // Derive initial calibration source from global mode
  const [calSource, setCalSource] = useState<CalibrationSource>(
    limitSourceMode === "calibrated" ? "best" : "off"
  );

  const scopes: { key: string; label: string; scopeKey: CalibrationScope; defaultWindow: "5h" | "weekly" }[] = [
    { key: "5h", label: "5-Hour Window", scopeKey: "5h", defaultWindow: "5h" },
    { key: "weekly", label: "7-Day (Weekly)", scopeKey: "weekly-all", defaultWindow: "weekly" },
  ];

  const saveOverride = async (overrideKey: string, field: LimitField, val: number | null) => {
    if (val === null) {
      await fetch(`/api/limit-overrides?key=${encodeURIComponent(overrideKey)}&field=${field}`, { method: "DELETE" });
    } else {
      await fetch("/api/limit-overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: overrideKey, entry: { [field]: val } }),
      });
    }
    onOverrideChange();
  };

  // Check available calibration methods per scope
  const availableMethods = useMemo(() => {
    const methods = new Set<string>();
    for (const { scopeKey } of scopes) {
      const s = solvedLimits[scopeKey];
      if (s.methods.length > 0 && s.best.confidence > 0) {
        methods.add("best");
        for (const m of s.methods) {
          if (m.confidence > 0) methods.add(m.method);
        }
      }
    }
    return methods;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solvedLimits]);

  const hasAnyCalibration = availableMethods.size > 0;

  const handleSourceChange = (source: CalibrationSource) => {
    setCalSource(source);
    onLimitSourceModeChange(source === "off" ? "manual" : "calibrated");
  };

  const useCalibrated = calSource !== "off";

  // Get limits for a given scope and tier based on selected source
  const getLimitsForTier = (solved: SolvedLimits, tier: PlanTier, defaultWindow: "5h" | "weekly"): PlanLimits | null => {
    if (!useCalibrated || solved.methods.length === 0 || solved.best.confidence <= 0) {
      return getDefaultLimits(tier, defaultWindow);
    }
    if (calSource === "best") {
      return calibratedPlanLimits(solved, tier);
    }
    // Try specific method, fall back to best
    const methodLimits = calibratedPlanLimitsByMethod(solved, tier, calSource as EstimationMethod);
    return methodLimits ?? calibratedPlanLimits(solved, tier);
  };

  // Get confidence for current source
  const getSourceConfidence = (solved: SolvedLimits): number | null => {
    if (!useCalibrated || solved.methods.length === 0) return null;
    if (calSource === "best") return solved.best.confidence;
    const entry = solved.methods.find((m) => m.method === calSource);
    return entry?.confidence ?? null;
  };

  return (
    <div className="flex gap-5">
      {/* Left sidebar — calibration source selector */}
      <div className="shrink-0 w-[88px] space-y-1.5">
        <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-2 px-1">
          Kalibracja
        </div>
        {CALIBRATION_SOURCES.map(({ key, label, color, description }) => {
          const isActive = calSource === key;
          const isAvailable = key === "off" || availableMethods.has(key);
          return (
            <button
              key={key}
              onClick={() => isAvailable && handleSourceChange(key)}
              disabled={!isAvailable}
              title={description}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[11px] font-medium transition-all text-left ${
                isActive
                  ? "ring-1 shadow-sm"
                  : "hover:bg-[var(--bg-secondary)]"
              } ${!isAvailable ? "opacity-40 cursor-default" : "cursor-pointer"}`}
              style={{
                color: isActive ? color : "var(--text-muted)",
                background: isActive ? `color-mix(in srgb, ${color} 10%, transparent)` : undefined,
                boxShadow: isActive ? `0 0 0 1px ${color}` : undefined,
              }}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0 transition-colors"
                style={{ background: isActive ? color : "var(--text-muted)" }}
              />
              {label}
            </button>
          );
        })}
        <p className="text-[8px] text-[var(--text-muted)] leading-tight px-1 pt-1">
          {calSource === "off" && "Hardcoded defaults"}
          {calSource === "best" && "Ensemble z wszystkich metod"}
          {calSource === "cost" && "Z kosztu API ($)"}
          {calSource === "direct" && "Z tokenów bezpośrednio"}
        </p>
      </div>

      {/* Right — tables */}
      <div className="flex-1 min-w-0 space-y-4">
        <p className="text-[10px] text-[var(--text-muted)]">
          Limity per plan. Kliknij wartość aby edytować.
          <span className="border-b border-dashed border-[var(--text-muted)] ml-1">Podkreślone</span> = ręcznie nadpisane.
        </p>

        {scopes.map(({ key, label, scopeKey, defaultWindow }) => {
          const solved = solvedLimits[scopeKey];
          const conf = getSourceConfidence(solved);
          const hasData = useCalibrated && conf !== null && conf > 0;
          const usingFallback = useCalibrated && calSource !== "best" &&
            !solved.methods.some((m) => m.method === calSource && m.confidence > 0) &&
            solved.best.confidence > 0;

          return (
            <div key={key}>
              <div className="flex items-center gap-2 mb-2">
                <h4 className="text-xs font-semibold text-[var(--text-secondary)]">
                  {label}
                </h4>
                {hasData && conf != null && (
                  <ConfidenceBadge confidence={conf} />
                )}
                {usingFallback && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/10 text-[var(--accent-orange)] font-medium">
                    fallback → best
                  </span>
                )}
                {!hasData && !usingFallback && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)] font-medium">
                    default
                  </span>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)]">
                      <th className="text-left py-1.5 px-2 text-[var(--text-muted)] font-medium">Plan</th>
                      <th className="text-right py-1.5 px-2 text-[var(--text-muted)] font-medium">Mult</th>
                      <th className={`text-right py-1.5 px-2 font-medium ${calSource === "cost" ? "text-[var(--accent-orange)]" : "text-[var(--accent-orange)]"}`}>Cost Limit</th>
                      <th className={`text-right py-1.5 px-2 font-medium ${calSource === "direct" ? "text-[var(--accent-blue)]" : "text-[var(--text-muted)]"}`}>Output</th>
                      <th className={`text-right py-1.5 px-2 font-medium ${calSource === "direct" ? "text-[var(--accent-blue)]" : "text-[var(--text-muted)]"}`}>In+Out</th>
                      <th className={`text-right py-1.5 px-2 font-medium ${calSource === "direct" ? "text-[var(--accent-blue)]" : "text-[var(--text-muted)]"}`}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PLAN_TIER_KEYS.map((tier) => {
                      const info = PLAN_TIERS[tier];
                      const lim = getLimitsForTier(solved, tier, defaultWindow);
                      if (!lim) return null;
                      const oKey = `${tier}:${key}`;
                      const ov = overrides[oKey];
                      return (
                        <tr key={tier} className="border-b border-[var(--border-subtle)]">
                          <td className="py-1.5 px-2 font-medium" style={{ color: info.color }}>
                            {info.label}
                            <span className="text-[var(--text-muted)] font-normal ml-1">
                              ${info.monthlyPrice}/mo
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-[var(--text-muted)]">
                            {info.multiplier}x
                          </td>
                          <EditableCell value={lim.costLimit} overrideValue={ov?.costLimit} field="costLimit" overrideKey={oKey} isCost color="var(--accent-orange)" bold onSave={saveOverride} />
                          <EditableCell value={lim.outputLimit} overrideValue={ov?.outputLimit} field="outputLimit" overrideKey={oKey} onSave={saveOverride} />
                          <EditableCell value={lim.inputOutputLimit} overrideValue={ov?.inputOutputLimit} field="inputOutputLimit" overrideKey={oKey} onSave={saveOverride} />
                          <EditableCell value={lim.totalLimit} overrideValue={ov?.totalLimit} field="totalLimit" overrideKey={oKey} onSave={saveOverride} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}

        <p className="text-[9px] text-[var(--text-muted)]">
          {calSource === "off" && "Domyślne limity (hardcoded base), skalowane mnożnikiem planu."}
          {calSource === "best" && "Baza: ensemble z kalibracji (Max $200), skalowane mnożnikiem planu."}
          {calSource === "cost" && "Baza: kalibracja cost ($), skalowane mnożnikiem planu."}
          {calSource === "direct" && "Baza: kalibracja z tokenów (direct), skalowane mnożnikiem planu."}
          {" "}Podczas promo 2x off-peak limity się podwajają.
        </p>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type CalSubTab = "points" | "estimates" | "limits";

export function CalibrationPanel({
  calibrations,
  solvedLimits,
  onCalibrationChange,
  planPeriods = [],
  limitOverrides = {},
  onLimitOverridesChange,
  limitSourceMode,
  onLimitSourceModeChange,
}: Props) {
  const [subTab, setSubTab] = useState<CalSubTab>("points");
  const [showDialog, setShowDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ReturnType<typeof groupByObservation>[0] | null>(null);
  const [flaggingPointId, setFlaggingPointId] = useState<string | null>(null);

  const parseError = async (response: Response, fallback: string) => {
    if (response.ok) return;
    try {
      const payload = (await response.json()) as { error?: string };
      throw new Error(payload.error || fallback);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(fallback);
    }
  };

  const handleSave = async (
    s: number | null,
    wa: number | null,
    ws: number | null,
    isoTime: string,
    onStatus?: (message: string) => void,
  ) => {
    const scopes: { scope: CalibrationScope; pct: number }[] = [];
    if (s !== null) scopes.push({ scope: "5h", pct: s });
    if (wa !== null) scopes.push({ scope: "weekly-all", pct: wa });
    if (ws !== null) scopes.push({ scope: "weekly-sonnet", pct: ws });

    onStatus?.(
      scopes.length > 1
        ? `Calculating snapshots and saving ${scopes.length} points...`
        : "Calculating snapshot and saving point..."
    );
    const response = await fetch("/api/calibrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: scopes.map(({ scope, pct }) => ({
          reportedPct: pct,
          scope,
          observedAt: isoTime,
        })),
      }),
    });
    await parseError(response, "Failed to save calibration");

    onStatus?.("Refreshing calibration list...");
    await onCalibrationChange();
  };

  const handleEditSave = async (
    group: ReturnType<typeof groupByObservation>[0],
    s: number | null,
    wa: number | null,
    ws: number | null,
    isoTime: string,
    onStatus?: (message: string) => void,
  ) => {
    const scopeEntries: [CalibrationScope, number | null][] = [
      ["5h", s],
      ["weekly-all", wa],
      ["weekly-sonnet", ws],
    ];
    const totalOps = scopeEntries.reduce((count, [scope, newPct]) => {
      const existing = group.points[scope];
      return existing || newPct !== null ? count + 1 : count;
    }, 0);
    let opIndex = 0;

    for (const [scope, newPct] of scopeEntries) {
      const existing = group.points[scope];
      if (existing && newPct !== null) {
        opIndex += 1;
        onStatus?.(`Updating calibration ${opIndex}/${totalOps}...`);
        const response = await fetch("/api/calibrations", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: existing.id, reportedPct: newPct, observedAt: isoTime }),
        });
        await parseError(response, "Failed to update calibration");
      } else if (existing && newPct === null) {
        opIndex += 1;
        onStatus?.(`Removing calibration ${opIndex}/${totalOps}...`);
        const response = await fetch(`/api/calibrations?id=${existing.id}`, { method: "DELETE" });
        await parseError(response, "Failed to delete calibration");
      } else if (!existing && newPct !== null) {
        opIndex += 1;
        onStatus?.(`Creating calibration ${opIndex}/${totalOps}...`);
        const response = await fetch("/api/calibrations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportedPct: newPct, scope, observedAt: isoTime }),
        });
        await parseError(response, "Failed to create calibration");
      }
    }
    onStatus?.("Refreshing calibration list...");
    await onCalibrationChange();
  };

  const patchAnomalyFlag = async (pointId: string, flag: AnomalyFlag) => {
    await fetch('/api/calibrations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pointId, anomalyFlag: flag }),
    });
    await onCalibrationChange();
  };

  const handleRemoveGroup = async (group: ReturnType<typeof groupByObservation>[0]) => {
    const ids = Object.values(group.points).filter(Boolean).map((p) => p!.id);
    for (const id of ids) {
      await fetch(`/api/calibrations?id=${id}`, { method: "DELETE" });
    }
    await onCalibrationChange();
  };

  const groups = groupByObservation(calibrations);

  const SCOPE_META: { scope: CalibrationScope; label: string; color: string }[] = [
    { scope: "5h", label: "Session (5h)", color: "var(--accent-blue)" },
    { scope: "weekly-all", label: "Weekly All", color: "var(--accent-purple)" },
    { scope: "weekly-sonnet", label: "Weekly Sonnet", color: "var(--accent-green)" },
  ];

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Sub-tab nav + Add button */}
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-0">
        <div className="flex gap-1">
          {(["points", "estimates", "limits"] as CalSubTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              className={`px-4 py-2 text-xs font-medium transition-all border-b-2 -mb-px ${
                subTab === t
                  ? "border-[var(--accent-blue)] text-[var(--accent-blue)]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {t === "points" ? "Points" : t === "estimates" ? "Estimates" : "Limits"}
            </button>
          ))}
        </div>
        {subTab === "points" && (
          <button
            onClick={() => { setEditingGroup(null); setShowDialog(true); }}
            className="mb-0.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent-blue)] text-white hover:opacity-90 transition-opacity"
          >
            + Add
          </button>
        )}
      </div>

      {/* Estimates — 3 columns */}
      {subTab === "estimates" && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            {SCOPE_META.map(({ scope, label, color }) => {
              const s = solvedLimits[scope];
              return (
                <div key={scope} className="card p-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color }}>
                    {label}
                  </div>
                  {s.methods.length > 0 ? (
                    <SolvedDisplay solved={s} />
                  ) : (
                    <div className="p-3 bg-[var(--bg-secondary)] rounded-lg text-xs text-[var(--text-muted)] text-center">
                      Brak danych — dodaj punkty kalibracyjne.
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <PerPercentAnalyticsPanel
            calibrations={calibrations}
            planPeriods={planPeriods}
          />
        </div>
      )}

      {/* Limits tab — calibrated plan limits */}
      {subTab === "limits" && (
        <div className="card p-5">
          <CalibratedPlanLimitsTable
            solvedLimits={solvedLimits}
            overrides={limitOverrides}
            onOverrideChange={onLimitOverridesChange ?? (() => {})}
            limitSourceMode={limitSourceMode}
            onLimitSourceModeChange={onLimitSourceModeChange}
          />
        </div>
      )}

      {/* Points tab — history table only */}
      {subTab === "points" && (
      <div className="card p-5">
        {groups.length === 0 ? (
          <div className="text-center py-8 text-sm text-[var(--text-muted)]">
            Brak punktów — kliknij <span className="text-[var(--accent-blue)]">+ Add</span> aby dodać obserwację.
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-[var(--text-secondary)]">History</span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {calibrations.length} points · {groups.length} observations
              </span>
            </div>

            {(() => {
              const flagged = calibrations.filter(p => p.anomalyFlag?.status === 'flagged').length;
              const excluded = calibrations.filter(p => p.anomalyFlag?.status === 'excluded').length;
              if (flagged === 0 && excluded === 0) return null;
              return (
                <div className="mb-2 text-[11px] flex gap-3">
                  {flagged > 0 && <span className="text-yellow-400">⚠ {flagged} z odchyleniem</span>}
                  {excluded > 0 && <span className="text-red-400">✕ {excluded} wykluczone</span>}
                </div>
              );
            })()}

            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left text-[10px] text-[var(--text-muted)] font-medium uppercase tracking-wider py-2 pr-3">
                      Time
                    </th>
                    <th className="text-right text-[10px] font-medium uppercase tracking-wider py-2 px-3" style={{ color: "var(--accent-blue)" }}>
                      Session
                    </th>
                    <th className="text-right text-[10px] font-medium uppercase tracking-wider py-2 px-3" style={{ color: "var(--accent-purple)" }}>
                      Weekly All
                    </th>
                    <th className="text-right text-[10px] font-medium uppercase tracking-wider py-2 px-3" style={{ color: "var(--accent-green)" }}>
                      Weekly Sonnet
                    </th>
                    <th className="w-16 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g, i) => {
                    const s = g.points["5h"];
                    const wa = g.points["weekly-all"];
                    const ws = g.points["weekly-sonnet"];
                    return (
                      <tr
                        key={i}
                        className="border-b border-[var(--border-subtle)]/50 hover:bg-[var(--bg-secondary)] group"
                      >
                        <td className="py-2 pr-3 text-[var(--text-muted)] whitespace-nowrap">
                          {formatTime(g.timestamp)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">
                          {s ? (
                            <div>
                              <div className="flex items-center justify-end gap-1">
                                {s.anomalyFlag?.status === 'flagged' && (
                                  <button
                                    onClick={() => setFlaggingPointId(flaggingPointId === s.id ? null : s.id)}
                                    className="text-yellow-400 hover:opacity-70 text-[11px]"
                                    title="Anomalia — kliknij aby przejrzeć"
                                  >⚠</button>
                                )}
                                {s.anomalyFlag?.status === 'excluded' && (
                                  <button
                                    onClick={() => setFlaggingPointId(flaggingPointId === s.id ? null : s.id)}
                                    className="text-red-400 hover:opacity-70 text-[11px]"
                                    title="Wykluczone z obliczeń"
                                  >✕</button>
                                )}
                                <span className={`font-medium ${s.anomalyFlag?.status === 'excluded' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                                  {s.reportedPct}%
                                </span>
                              </div>
                              <div className="text-[9px] text-[var(--text-muted)]">
                                {formatTokens(s.tokens?.total ?? 0)}
                              </div>
                              {flaggingPointId === s.id && (
                                <AnomalyFlagPanel
                                  point={s}
                                  onPatch={(flag) => patchAnomalyFlag(s.id, flag)}
                                  onClose={() => setFlaggingPointId(null)}
                                />
                              )}
                            </div>
                          ) : (
                            <span className="text-[var(--text-muted)]">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">
                          {wa ? (
                            <div>
                              <div className="flex items-center justify-end gap-1">
                                {wa.anomalyFlag?.status === 'flagged' && (
                                  <button
                                    onClick={() => setFlaggingPointId(flaggingPointId === wa.id ? null : wa.id)}
                                    className="text-yellow-400 hover:opacity-70 text-[11px]"
                                    title="Anomalia — kliknij aby przejrzeć"
                                  >⚠</button>
                                )}
                                {wa.anomalyFlag?.status === 'excluded' && (
                                  <button
                                    onClick={() => setFlaggingPointId(flaggingPointId === wa.id ? null : wa.id)}
                                    className="text-red-400 hover:opacity-70 text-[11px]"
                                    title="Wykluczone z obliczeń"
                                  >✕</button>
                                )}
                                <span className={`font-medium ${wa.anomalyFlag?.status === 'excluded' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                                  {wa.reportedPct}%
                                </span>
                              </div>
                              <div className="text-[9px] text-[var(--text-muted)]">
                                {formatTokens(wa.tokens?.total ?? 0)}
                              </div>
                              {flaggingPointId === wa.id && (
                                <AnomalyFlagPanel
                                  point={wa}
                                  onPatch={(flag) => patchAnomalyFlag(wa.id, flag)}
                                  onClose={() => setFlaggingPointId(null)}
                                />
                              )}
                            </div>
                          ) : (
                            <span className="text-[var(--text-muted)]">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">
                          {ws ? (
                            <div>
                              <div className="flex items-center justify-end gap-1">
                                {ws.anomalyFlag?.status === 'flagged' && (
                                  <button
                                    onClick={() => setFlaggingPointId(flaggingPointId === ws.id ? null : ws.id)}
                                    className="text-yellow-400 hover:opacity-70 text-[11px]"
                                    title="Anomalia — kliknij aby przejrzeć"
                                  >⚠</button>
                                )}
                                {ws.anomalyFlag?.status === 'excluded' && (
                                  <button
                                    onClick={() => setFlaggingPointId(flaggingPointId === ws.id ? null : ws.id)}
                                    className="text-red-400 hover:opacity-70 text-[11px]"
                                    title="Wykluczone z obliczeń"
                                  >✕</button>
                                )}
                                <span className={`font-medium ${ws.anomalyFlag?.status === 'excluded' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                                  {ws.reportedPct}%
                                </span>
                              </div>
                              <div className="text-[9px] text-[var(--text-muted)]">
                                {formatTokens(ws.tokens?.total ?? 0)}
                              </div>
                              {flaggingPointId === ws.id && (
                                <AnomalyFlagPanel
                                  point={ws}
                                  onPatch={(flag) => patchAnomalyFlag(ws.id, flag)}
                                  onClose={() => setFlaggingPointId(null)}
                                />
                              )}
                            </div>
                          ) : (
                            <span className="text-[var(--text-muted)]">—</span>
                          )}
                        </td>
                        <td className="py-2 pl-1">
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                            <button
                              onClick={() => { setEditingGroup(g); setShowDialog(true); }}
                              className="px-1.5 py-0.5 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-secondary)] transition-colors"
                              title="Edytuj obserwację"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleRemoveGroup(g)}
                              className="px-1.5 py-0.5 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-secondary)] transition-colors"
                              title="Usuń obserwację"
                            >
                              Del
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      )}

      {showDialog && (
        <CalibrationDialog
          initial={editingGroup ? {
            pctSession: editingGroup.points["5h"]?.reportedPct,
            pctWeeklyAll: editingGroup.points["weekly-all"]?.reportedPct,
            pctWeeklySonnet: editingGroup.points["weekly-sonnet"]?.reportedPct,
            observedAt: editingGroup.timestamp,
          } : undefined}
          onSave={editingGroup
            ? (s, wa, ws, isoTime) => handleEditSave(editingGroup, s, wa, ws, isoTime)
            : handleSave
          }
          onClose={() => { setShowDialog(false); setEditingGroup(null); }}
        />
      )}
    </div>
  );
}
