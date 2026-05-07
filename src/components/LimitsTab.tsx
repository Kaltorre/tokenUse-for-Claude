"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  LimitsData,
  FiveHourWindow,
  WeeklyBucket,
  CalibrationScope,
  SolvedLimits,
  DerivedLimits,
  SessionOverrides,
  CalibrationPoint,
  PlanPeriod,
  SessionStats,
  PLAN_TIERS,
  PromoPeriod,
  DEFAULT_LIMITS_5H,
  DEFAULT_LIMITS_WEEKLY,
} from "@/lib/types";
import { getPlanTierForDate, weekKeyFromDate } from "@/lib/plans";
import { formatTokens, formatCost } from "@/lib/format";
import {
  estimateUtilization,
  getCalibrationForWindow,
  findCalibrationAnchor,
  findCalibrationSeries,
} from "@/lib/calibration";
import { computeLimitInsight } from "@/lib/limit-insights";
import {
  calcUtilization,
  getActivePromoMultiplier,
  isInPromoRange,
  BOTTLENECK_LABELS,
  BOTTLENECK_COLORS,
} from "@/lib/utilization";
import { computeWeightedPromoMultiplier } from "@/lib/limits-analyzer";
import {
  LimitRegimeEvidenceRow,
  buildUtilizationResidual,
  buildLimitRegimeEvidence,
  estimatePctFromCostProxy,
} from "@/lib/limit-regimes";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EMPTY_PROMO_PERIODS: PromoPeriod[] = [];
const EMPTY_PLAN_PERIODS: PlanPeriod[] = [];
const EMPTY_SESSIONS: SessionStats[] = [];

function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
}

function formatLocalDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pl-PL", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function formatWeekRange(weekStart: string, weekEnd: string): string {
  const s = new Date(weekStart);
  const e = new Date(weekEnd);
  const fmt = (d: Date) => d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
  return `${fmt(s)} – ${fmt(e)}`;
}

function formatPct(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function formatSignedPct(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} pp`;
}

function formatRatio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}x`;
}

/** Standard ISO week key: YYYY-WNN */
function isoWeekKey(dateStr: string): string {
  const date = new Date(dateStr);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, "0")}`;
}

/** Convert ISO timestamp to datetime-local input value (local time) */
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert datetime-local input value to ISO timestamp */
function fromDatetimeLocal(local: string): string {
  return new Date(local).toISOString();
}

function getStartPromoMultiplier(windowStart: string, promoPeriods: PromoPeriod[] = []): number {
  if (promoPeriods.length > 0) {
    return getActivePromoMultiplier(windowStart, promoPeriods);
  }
  return isInPromoRange(windowStart) ? 2 : 1;
}

function getWindowPromoMultiplier(
  win: Pick<FiveHourWindow, "startTime" | "peakStatus" | "peakSplit">,
  promoPeriods: PromoPeriod[] = []
): number {
  if (win.peakStatus === "mixed" && win.peakSplit) {
    return computeWeightedPromoMultiplier(win.peakSplit);
  }
  if (win.peakStatus === "off-peak") {
    const configured = getStartPromoMultiplier(win.startTime, promoPeriods);
    return configured !== 1 ? configured : 1;
  }
  return 1;
}

function hasSolvedScopeLimits(
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null,
  scope: CalibrationScope
): boolean {
  const solved = solvedLimits?.[scope];
  return Boolean(solved && solved.methods.length > 0 && solved.best.confidence > 0);
}

function getDisplayPlanMultiplier(
  planTier: PlanPeriod["tier"] | null,
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null,
  scope: CalibrationScope
): number {
  const tierMultiplier = PLAN_TIERS[planTier ?? "max20"].multiplier;
  return hasSolvedScopeLimits(solvedLimits, scope)
    ? tierMultiplier / PLAN_TIERS.max20.multiplier
    : tierMultiplier;
}

type WeeklyOverrideScope = "all" | "sonnet";

function getWeeklyOverrideStorageKey(
  scope: WeeklyOverrideScope,
  bucket: Pick<WeeklyBucket, "weekStart">
): string {
  return `${scope}:${bucket.weekStart}`;
}

function getWeeklyOverrideMatch(
  overrides: SessionOverrides,
  bucket: Pick<WeeklyBucket, "weekStart">,
  scope: WeeklyOverrideScope
): { key: string; entry: SessionOverrides["weekly"][string] } | null {
  const scopedKey = getWeeklyOverrideStorageKey(scope, bucket);
  if (overrides.weekly[scopedKey]) {
    return { key: scopedKey, entry: overrides.weekly[scopedKey] };
  }

  const legacyKey = weekKeyFromDate(bucket.weekStart);
  if (overrides.weekly[legacyKey]) {
    return { key: legacyKey, entry: overrides.weekly[legacyKey] };
  }

  return null;
}

// ─── Regime evidence matrix ─────────────────────────────────────────────────

function statusColor(status: LimitRegimeEvidenceRow["latestResidual"]["status"]): string {
  if (status === "close") return "var(--accent-green)";
  if (status === "watch") return "var(--accent-orange)";
  if (status === "suspicious") return "var(--accent-red)";
  return "var(--text-muted)";
}

function regimeLabel(row: LimitRegimeEvidenceRow): string {
  if (row.regime) return row.regime.label;
  if (row.regimeStatus === "ambiguous") return "Ambiguous regime";
  return "Unassigned regime";
}

function scopeLabel(scope: CalibrationScope): string {
  if (scope === "5h") return "5h";
  if (scope === "weekly-all") return "Weekly ALL";
  return "Weekly SNNT";
}

function LimitRegimeEvidencePanel({
  calibrations,
  planPeriods,
}: {
  calibrations: CalibrationPoint[];
  planPeriods: PlanPeriod[];
}) {
  const rows = buildLimitRegimeEvidence(calibrations, planPeriods);
  const hasRows = rows.length > 0;
  const chartPoints = rows
    .flatMap((row) =>
      row.points.map((point) => {
        const estimatedPct = estimatePctFromCostProxy(
          point.costProxy,
          row.effectiveCostProxyLimit
        );
        const residual = buildUtilizationResidual(point.observedPct, estimatedPct);
        return {
          id: point.id,
          timestamp: point.timestamp,
          time: `${formatShortDate(point.timestamp)} ${formatLocalTime(point.timestamp)}`,
          regime: regimeLabel(row),
          scope: scopeLabel(row.scope),
          observedPct: point.observedPct,
          estimatedPct,
          deltaPct: residual.deltaPct,
        };
      })
    )
    .filter((point) => point.estimatedPct != null)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-80);

  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">
            Plan / Window Inference
          </h3>
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Cost proxy is inferred from observed Anthropic % per plan epoch and window.
            Theory match compares inferred multiplier against the configured plan hypothesis.
          </p>
        </div>
        <span className="text-[10px] text-[var(--text-muted)]">
          {rows.length} calibrated regimes
        </span>
      </div>

      {!hasRows ? (
        <div className="rounded-lg bg-[var(--bg-secondary)] p-4 text-center text-xs text-[var(--text-muted)]">
          Add calibration points with observed Anthropic % to infer cost proxy per 1%.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[var(--border-subtle)]">
                <th className="py-2 pr-3 text-left font-medium text-[var(--text-muted)]">
                  Regime
                </th>
                <th className="px-3 py-2 text-left font-medium text-[var(--text-muted)]">
                  Window
                </th>
                <th className="px-3 py-2 text-right font-medium text-[var(--text-muted)]">
                  Points
                </th>
                <th className="px-3 py-2 text-right font-medium text-[var(--text-muted)]">
                  Cost proxy / 1%
                </th>
                <th className="px-3 py-2 text-right font-medium text-[var(--text-muted)]">
                  Effective 100%
                </th>
                <th className="px-3 py-2 text-right font-medium text-[var(--text-muted)]">
                  Theory
                </th>
                <th className="px-3 py-2 text-right font-medium text-[var(--text-muted)]">
                  Inferred
                </th>
                <th className="px-3 py-2 text-right font-medium text-[var(--text-muted)]">
                  Match
                </th>
                <th className="pl-3 py-2 text-right font-medium text-[var(--text-muted)]">
                  Latest delta
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const color = row.regime
                  ? PLAN_TIERS[row.regime.tier].color
                  : "var(--text-muted)";
                const residualColor = statusColor(row.latestResidual.status);

                return (
                  <tr
                    key={row.key}
                    className="border-b border-[var(--border-subtle)]/70 last:border-0"
                  >
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: color }}
                        />
                        <span className="font-medium" style={{ color }}>
                          {regimeLabel(row)}
                        </span>
                      </div>
                      <div className="text-[9px] text-[var(--text-muted)]">
                        {row.regime?.startDate
                          ? `${formatShortDate(row.regime.startDate)} - ${
                              row.regime.endDate ? formatShortDate(row.regime.endDate) : "now"
                            }`
                          : row.regimeStatus}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">
                      {scopeLabel(row.scope)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">
                      {row.calibrationCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--accent-orange)]">
                      {row.costProxyPerPct == null ? "—" : formatCost(row.costProxyPerPct)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--accent-orange)]">
                      {row.effectiveCostProxyLimit == null
                        ? "—"
                        : formatCost(row.effectiveCostProxyLimit)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">
                      {formatRatio(row.theoreticalMultiplier)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">
                      {formatRatio(row.inferredMultiplier)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">
                      {formatRatio(row.theoryMatchRatio)}
                    </td>
                    <td className="pl-3 py-2 text-right tabular-nums">
                      <span
                        className="rounded px-2 py-1 font-medium"
                        style={{
                          color: residualColor,
                          background: `color-mix(in srgb, ${residualColor} 12%, transparent)`,
                        }}
                      >
                        {formatSignedPct(row.latestResidual.deltaPct)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {chartPoints.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-medium text-[var(--text-secondary)]">
                Observed vs Estimated
              </h4>
              <p className="text-[10px] text-[var(--text-muted)]">
                Lines compare Anthropic observed % with the current cost-proxy estimate.
                Bars are signed residuals.
              </p>
            </div>
            <span className="text-[10px] text-[var(--text-muted)]">
              latest {chartPoints.length} points
            </span>
          </div>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartPoints}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border-subtle)"
                  vertical={false}
                />
                <XAxis
                  dataKey="time"
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  axisLine={{ stroke: "var(--border-subtle)" }}
                  tickLine={false}
                  minTickGap={32}
                />
                <YAxis
                  yAxisId="pct"
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={38}
                  unit="%"
                />
                <YAxis
                  yAxisId="delta"
                  orientation="right"
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                  unit="pp"
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--text-secondary)",
                    fontSize: 12,
                  }}
                  labelFormatter={(
                    _,
                    payload: ReadonlyArray<{ payload?: (typeof chartPoints)[number] }>
                  ) => {
                    const point = payload?.[0]?.payload as
                      | (typeof chartPoints)[number]
                      | undefined;
                    return point
                      ? `${point.time} · ${point.regime} · ${point.scope}`
                      : "";
                  }}
                  formatter={(value: number, name) => {
                    const label =
                      name === "observedPct"
                        ? "Observed"
                        : name === "estimatedPct"
                        ? "Estimated"
                        : "Delta";
                    const suffix = name === "deltaPct" ? " pp" : "%";
                    return [`${Number(value).toFixed(1)}${suffix}`, label];
                  }}
                />
                <Bar
                  yAxisId="delta"
                  dataKey="deltaPct"
                  fill="var(--accent-orange)"
                  opacity={0.35}
                  radius={[3, 3, 0, 0]}
                  name="Delta"
                />
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="observedPct"
                  stroke="var(--accent-blue)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "var(--accent-blue)" }}
                  name="Observed"
                />
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="estimatedPct"
                  stroke="var(--accent-green)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "var(--accent-green)" }}
                  name="Estimated"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Token breakdown sub-component ───────────────────────────────────────────

// ─── Inline editable value ──────────────────────────────────────────────────

type TokenField = "input" | "output" | "cacheWrite" | "cacheRead";

interface TokenOverrides {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
}

function InlineEditableValue({
  value,
  overrideValue,
  formatFn,
  onCommit,
  color,
}: {
  value: number;
  overrideValue?: number;
  formatFn: (n: number) => string;
  onCommit: (val: number | null) => void;
  color?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const hasOverride = overrideValue != null;
  const displayValue = hasOverride ? overrideValue : value;

  const startEdit = () => {
    setEditVal(String(displayValue));
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const parsed = parseFloat(editVal);
    if (isNaN(parsed) || parsed < 0) return;
    const rounded = Math.round(parsed);
    if (rounded === value) {
      if (hasOverride) onCommit(null);
    } else {
      onCommit(rounded);
    }
  };

  if (editing) {
    return (
      <input
        type="number"
        value={editVal}
        onChange={(e) => setEditVal(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitEdit();
          if (e.key === "Escape") setEditing(false);
        }}
        autoFocus
        step="1000"
        className="w-20 bg-[var(--bg-primary)] border-2 border-[var(--accent-blue)] rounded px-1 py-0 text-[11px] text-right tabular-nums text-[var(--text-primary)] focus:outline-none"
      />
    );
  }

  return (
    <span
      onClick={startEdit}
      title="Kliknij aby zmienić (what-if)"
      className={`group/val inline-flex items-center gap-0.5 tabular-nums text-right cursor-pointer rounded px-1 -mx-1 py-0.5 transition-colors hover:bg-[var(--accent-blue)]/10 ${
        hasOverride ? "border-b-2 border-dashed border-[var(--accent-blue)]" : ""
      }`}
      style={{ color: hasOverride ? "var(--accent-blue)" : color ?? "var(--text-secondary)" }}
    >
      <span className="w-16 text-right">{formatFn(displayValue)}</span>
      <svg className="w-2.5 h-2.5 opacity-0 group-hover/val:opacity-50 transition-opacity shrink-0" viewBox="0 0 16 16" fill="currentColor">
        <path d="M12.1 1.3a1 1 0 0 1 1.4 0l1.2 1.2a1 1 0 0 1 0 1.4l-8.5 8.5-3.2.8.8-3.2 8.3-8.7zm.7.7L4.5 10.3l-.4 1.6 1.6-.4L14 3.2 12.8 2z"/>
      </svg>
    </span>
  );
}

// ─── Token breakdown sub-component ───────────────────────────────────────────

interface TokenBreakdownProps {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost?: number;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  scope: CalibrationScope;
  peakStatus?: "peak" | "off-peak" | "mixed";
  peakSplit?: FiveHourWindow["peakSplit"];
  windowStart?: string;
  promoPeriods?: PromoPeriod[];
  planMultiplier?: number;
  /** Ad-hoc overrides for what-if simulation */
  overrides?: TokenOverrides;
  onOverride?: (field: TokenField, value: number | null) => void;
}

function TokenBreakdown({
  inputTokens,
  outputTokens,
  cacheCreationTokens,
  cacheReadTokens,
  totalTokens,
  totalCost,
  solvedLimits,
  derivedLimits,
  scope,
  peakStatus = "off-peak",
  peakSplit,
  windowStart = new Date().toISOString(),
  planMultiplier = 1,
  promoPeriods = EMPTY_PROMO_PERIODS,
  overrides,
  onOverride,
}: TokenBreakdownProps) {
  // Apply overrides for what-if simulation
  const effInput = overrides?.input ?? inputTokens;
  const effOutput = overrides?.output ?? outputTokens;
  const effCacheWrite = overrides?.cacheWrite ?? cacheCreationTokens;
  const effCacheRead = overrides?.cacheRead ?? cacheReadTokens;
  const effTotal = effInput + effOutput + effCacheWrite + effCacheRead;
  const hasAnyOverride = overrides && (overrides.input != null || overrides.output != null || overrides.cacheWrite != null || overrides.cacheRead != null);

  // Estimate cost proportionally if tokens changed
  const costScale = totalTokens > 0 ? effTotal / totalTokens : 1;
  const effCost = (totalCost ?? 0) * costScale;

  // Try to compute per-type % of limit
  let outputPct: number | null = null;
  let ioPct: number | null = null;
  let totalPct: number | null = null;
  let bottleneck: string | null = null;

  if (solvedLimits) {
    const solved = solvedLimits[scope];
    if (solved && solved.best.confidence > 0) {
      const est = estimateUtilization(
        { output: effOutput, input: effInput, cacheWrite: effCacheWrite, cacheRead: effCacheRead, total: effTotal },
        effCost,
        solved,
        peakStatus,
        windowStart,
        peakSplit,
        promoPeriods,
        planMultiplier
      );
      if (est) {
        outputPct = est.outputPct;
        ioPct = est.ioPct;
        totalPct = est.totalPct;
        bottleneck = est.bottleneck;
      }
    }
  }

  if (outputPct === null && derivedLimits) {
    const util = calcUtilization(
      { outputTokens: effOutput, inputTokens: effInput, totalTokens: effTotal },
      derivedLimits,
      peakStatus,
      windowStart,
      scope === "5h" ? "5h" : "weekly",
      peakSplit,
      promoPeriods,
      planMultiplier
    );
    if (util) {
      outputPct = util.outputPct;
      ioPct = util.inoutPct;
      totalPct = util.totalPct;
      bottleneck = util.bottleneck;
    }
  }

  const rows: { label: string; field: TokenField; original: number; value: number; color: string; pct?: number | null; isBn: boolean }[] = [
    { label: "Input", field: "input", original: inputTokens, value: effInput, color: "var(--accent-blue)", isBn: false },
    { label: "Output", field: "output", original: outputTokens, value: effOutput, color: "var(--accent-green)", pct: outputPct, isBn: bottleneck === "output" },
    { label: "Cache Write", field: "cacheWrite", original: cacheCreationTokens, value: effCacheWrite, color: "var(--accent-purple)", isBn: false },
    { label: "Cache Read", field: "cacheRead", original: cacheReadTokens, value: effCacheRead, color: "var(--accent-cyan)", isBn: false },
  ];

  return (
    <div className="space-y-2">
      {hasAnyOverride && onOverride && (
        <div className="flex items-center justify-between text-[9px]">
          <span className="text-[var(--accent-blue)] font-medium">what-if mode</span>
          <button
            onClick={() => {
              onOverride("input", null);
              onOverride("output", null);
              onOverride("cacheWrite", null);
              onOverride("cacheRead", null);
            }}
            className="text-[var(--text-muted)] hover:text-[var(--accent-red)] transition-colors"
          >
            reset
          </button>
        </div>
      )}
      {rows.map((r) => {
        const barWidth = effTotal > 0 ? (r.value / effTotal) * 100 : 0;
        return (
          <div key={r.label} className="flex items-center gap-2 text-xs">
            <span className="w-20 text-[var(--text-muted)] text-right shrink-0">{r.label}</span>
            <div className="flex-1 h-2.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.min(barWidth, 100)}%`, background: r.color }} />
            </div>
            {onOverride ? (
              <InlineEditableValue
                value={r.original}
                overrideValue={overrides?.[r.field]}
                formatFn={formatTokens}
                onCommit={(val) => onOverride(r.field, val)}
                color="var(--text-secondary)"
              />
            ) : (
              <span className="w-16 text-[var(--text-secondary)] tabular-nums text-right">{formatTokens(r.value)}</span>
            )}
          </div>
        );
      })}

      {/* Utilization summary row */}
      {outputPct !== null && (
        <div className="flex items-center gap-3 pt-1.5 border-t border-[var(--border-subtle)] text-[10px]">
          {([
            ["Out", outputPct, "output"],
            ["I/O", ioPct, "inout"],
            ["Total", totalPct, "total"],
          ] as [string, number | null, string][]).map(([label, val, key]) => {
            const isBn = bottleneck === key;
            const color = isBn
              ? BOTTLENECK_COLORS[key as keyof typeof BOTTLENECK_COLORS] ?? "var(--text-secondary)"
              : "var(--text-muted)";
            return (
              <span key={key} style={{ color }} className={isBn ? "font-semibold" : ""}>
                {label} {val !== null ? `${val.toFixed(1)}%` : "—"}
                {isBn && " *"}
              </span>
            );
          })}
          <span className="ml-auto text-[var(--text-muted)]">
            {BOTTLENECK_LABELS[bottleneck as keyof typeof BOTTLENECK_LABELS] ?? ""}
          </span>
        </div>
      )}

      {/* Total row */}
      <div className="flex justify-between pt-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text-secondary)] tabular-nums">
          {formatTokens(effTotal)} total
          {hasAnyOverride && (
            <span className="text-[var(--accent-blue)] ml-1">(sim)</span>
          )}
        </span>
        {totalCost != null && (
          <span className="font-medium text-[var(--text-secondary)] tabular-nums">
            {formatCost(effCost)}
            {hasAnyOverride && (
              <span className="text-[var(--accent-blue)] ml-1">(~)</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function ValidationSummary({
  estimatedPct,
  observedPct,
  deltaPct,
  noPromoPct,
  observedAt,
}: {
  estimatedPct: number | null;
  observedPct: number | null;
  deltaPct: number | null;
  noPromoPct: number | null;
  observedAt?: string | null;
}) {
  if (
    estimatedPct == null &&
    observedPct == null &&
    deltaPct == null &&
    noPromoPct == null
  ) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--border-subtle)] text-[10px]">
      {estimatedPct != null && (
        <span className="px-2 py-1 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
          Est. {formatPct(estimatedPct)}
        </span>
      )}
      {observedPct != null && (
        <span className="px-2 py-1 rounded bg-[var(--bg-primary)] text-[var(--accent-blue)]">
          Obs. {formatPct(observedPct)}
        </span>
      )}
      {deltaPct != null && (
        <span
          className="px-2 py-1 rounded"
          style={{
            background:
              deltaPct >= 0
                ? "color-mix(in srgb, var(--accent-green) 12%, transparent)"
                : "color-mix(in srgb, var(--accent-orange) 12%, transparent)",
            color: deltaPct >= 0 ? "var(--accent-green)" : "var(--accent-orange)",
          }}
        >
          Δ {deltaPct > 0 ? "+" : ""}
          {formatPct(deltaPct)}
        </span>
      )}
      {noPromoPct != null && (
        <span className="px-2 py-1 rounded bg-[var(--bg-primary)] text-[var(--accent-orange)]">
          No promo {formatPct(noPromoPct)}
        </span>
      )}
      {observedAt && (
        <span className="text-[var(--text-muted)]">
          obs @ {formatLocalTime(observedAt)} {formatShortDate(observedAt)}
        </span>
      )}
    </div>
  );
}

// ─── Edit Boundaries Dialog ───────────────────────────────────────────────────

interface EditDialogProps {
  type: "weekly" | "5h";
  overrideKey: string;
  initialStart: string;
  initialEnd: string;
  onSave: (start: string, end: string) => Promise<void>;
  onClose: () => void;
}

function EditBoundariesDialog({
  type,
  overrideKey,
  initialStart,
  initialEnd,
  onSave,
  onClose,
}: EditDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [start, setStart] = useState(() => toDatetimeLocal(initialStart));
  const [end, setEnd] = useState(() => toDatetimeLocal(initialEnd));
  const [saving, setSaving] = useState(false);
  const startInputId = `${type}-${overrideKey}-start`;
  const endInputId = `${type}-${overrideKey}-end`;

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(fromDatetimeLocal(start), fromDatetimeLocal(end));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="card p-5 w-full max-w-sm mx-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
          Edit Window Boundaries
        </h3>
        <div className="text-[10px] text-[var(--text-muted)] mb-4">
          {type === "5h" ? "5h window" : "Weekly session"} — key: <code className="font-mono">{overrideKey}</code>
        </div>

        <div className="space-y-3 mb-5">
          <div>
            <label htmlFor={startInputId} className="block text-xs text-[var(--text-muted)] mb-1">Start</label>
            <input
              id={startInputId}
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
            />
          </div>
          <div>
            <label htmlFor={endInputId} className="block text-xs text-[var(--text-muted)] mb-1">End</label>
            <input
              id={endInputId}
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-xs font-medium bg-[var(--accent-blue)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Status Cards (Section A) ─────────────────────────────────────────────────

interface StatusCardsProps {
  currentWindow: FiveHourWindow | null;
  currentWeekAll: WeeklyBucket | null;
  currentWeekSonnet: WeeklyBucket | null;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  planPeriods?: PlanPeriod[];
  promoPeriods?: PromoPeriod[];
}

function StatusCards({
  currentWindow,
  currentWeekAll,
  currentWeekSonnet,
  solvedLimits,
  derivedLimits,
  calibrations,
  planPeriods = EMPTY_PLAN_PERIODS,
  promoPeriods = EMPTY_PROMO_PERIODS,
}: StatusCardsProps) {
  const [windowRemaining, setWindowRemaining] = useState(currentWindow?.timeRemainingMs ?? 0);
  const [weekRemaining, setWeekRemaining] = useState(currentWeekAll?.timeRemainingMs ?? 0);
  const [weekSonnetRemaining, setWeekSonnetRemaining] = useState(currentWeekSonnet?.timeRemainingMs ?? 0);

  // What-if overrides per card
  const [windowOv, setWindowOv] = useState<TokenOverrides>({});
  const [weekAllOv, setWeekAllOv] = useState<TokenOverrides>({});
  const [weekSonnetOv, setWeekSonnetOv] = useState<TokenOverrides>({});

  const makeOverrideHandler = (setter: React.Dispatch<React.SetStateAction<TokenOverrides>>) =>
    (field: TokenField, value: number | null) => {
      setter((prev) => {
        const next = { ...prev };
        if (value === null) {
          delete next[field];
        } else {
          next[field] = value;
        }
        return next;
      });
    };

  const currentWindowPlanTier = currentWindow && planPeriods
    ? getPlanTierForDate(currentWindow.startTime, planPeriods)
    : null;
  const currentWeekPlanTier = currentWeekAll && planPeriods
    ? getPlanTierForDate(currentWeekAll.weekStart, planPeriods)
    : null;
  const currentWeekSonnetPlanTier = currentWeekSonnet && planPeriods
    ? getPlanTierForDate(currentWeekSonnet.weekStart, planPeriods)
    : null;
  const currentWindowPlanMult = getDisplayPlanMultiplier(currentWindowPlanTier, solvedLimits, "5h");
  const currentWeekPlanMult = getDisplayPlanMultiplier(currentWeekPlanTier, solvedLimits, "weekly-all");
  const currentWeekSonnetPlanMult = getDisplayPlanMultiplier(currentWeekSonnetPlanTier, solvedLimits, "weekly-sonnet");
  const currentWindowAnchor = currentWindow
    ? findCalibrationAnchor(calibrations, "5h", currentWindow.startTime)
    : undefined;
  const currentWindowSeries = currentWindow
    ? findCalibrationSeries(calibrations, "5h", currentWindow.startTime)
    : [];
  const currentWeekAnchor = currentWeekAll
    ? findCalibrationAnchor(calibrations, "weekly-all", currentWeekAll.weekStart)
    : undefined;
  const currentWeekSeries = currentWeekAll
    ? findCalibrationSeries(calibrations, "weekly-all", currentWeekAll.weekStart)
    : [];
  const currentWeekSonnetAnchor = currentWeekSonnet
    ? findCalibrationAnchor(calibrations, "weekly-sonnet", currentWeekSonnet.weekStart)
    : undefined;
  const currentWeekSonnetSeries = currentWeekSonnet
    ? findCalibrationSeries(calibrations, "weekly-sonnet", currentWeekSonnet.weekStart)
    : [];
  const currentWindowInsight = currentWindow
    ? computeLimitInsight({
        scope: "5h",
        usage: {
          outputTokens: currentWindow.outputTokens,
          inputTokens: currentWindow.inputTokens,
          cacheCreationTokens: currentWindow.cacheCreationTokens,
          cacheReadTokens: currentWindow.cacheReadTokens,
          totalTokens: currentWindow.totalTokens,
          totalCost: currentWindow.totalCost,
          peakStatus: currentWindow.peakStatus,
          peakSplit: currentWindow.peakSplit,
          windowStart: currentWindow.startTime,
        },
        solvedLimits,
        derivedLimits,
        promos: promoPeriods,
        planMultiplier: currentWindowPlanMult,
        calibrationSeries: currentWindowSeries,
        calibrationAnchor: currentWindowAnchor,
        observedPoint: currentWindowAnchor,
      })
    : null;
  const currentWeekInsight = currentWeekAll
    ? computeLimitInsight({
        scope: "weekly-all",
        usage: {
          outputTokens: currentWeekAll.outputTokens,
          inputTokens: currentWeekAll.inputTokens,
          cacheCreationTokens: currentWeekAll.cacheCreationTokens,
          cacheReadTokens: currentWeekAll.cacheReadTokens,
          totalTokens: currentWeekAll.totalTokens,
          totalCost: currentWeekAll.totalCost,
          peakStatus: currentWeekAll.peakStatus ?? "peak",
          peakSplit: currentWeekAll.peakSplit,
          windowStart: currentWeekAll.weekStart,
        },
        solvedLimits,
        derivedLimits,
        promos: promoPeriods,
        planMultiplier: currentWeekPlanMult,
        calibrationSeries: currentWeekSeries,
        calibrationAnchor: currentWeekAnchor,
        observedPoint: currentWeekAnchor,
      })
    : null;
  const currentWeekSonnetInsight = currentWeekSonnet
    ? computeLimitInsight({
        scope: "weekly-sonnet",
        usage: {
          outputTokens: currentWeekSonnet.outputTokens,
          inputTokens: currentWeekSonnet.inputTokens,
          cacheCreationTokens: currentWeekSonnet.cacheCreationTokens,
          cacheReadTokens: currentWeekSonnet.cacheReadTokens,
          totalTokens: currentWeekSonnet.totalTokens,
          totalCost: currentWeekSonnet.totalCost,
          peakStatus: currentWeekSonnet.peakStatus ?? "peak",
          peakSplit: currentWeekSonnet.peakSplit,
          windowStart: currentWeekSonnet.weekStart,
        },
        solvedLimits,
        derivedLimits,
        promos: promoPeriods,
        planMultiplier: currentWeekSonnetPlanMult,
        calibrationSeries: currentWeekSonnetSeries,
        calibrationAnchor: currentWeekSonnetAnchor,
        observedPoint: currentWeekSonnetAnchor,
      })
    : null;

  useEffect(() => {
    if (!currentWindow && !currentWeekAll) return;
    const tick = () => {
      if (currentWindow?.status === "active") {
        setWindowRemaining(Math.max(0, new Date(currentWindow.endTime).getTime() - Date.now()));
      }
      if (currentWeekAll && currentWeekAll.timeRemainingMs > 0) {
        setWeekRemaining(Math.max(0, new Date(currentWeekAll.weekEnd).getTime() - Date.now()));
      }
      if (currentWeekSonnet && currentWeekSonnet.timeRemainingMs > 0) {
        setWeekSonnetRemaining(Math.max(0, new Date(currentWeekSonnet.weekEnd).getTime() - Date.now()));
      }
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [currentWindow, currentWeekAll, currentWeekSonnet]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
      {/* Card 1: Active 5h Window */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">Active 5h Window</h3>
          {currentWindow ? (
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${currentWindow.status === "active" ? "bg-[var(--accent-green)] animate-pulse" : "bg-[var(--text-muted)]"}`} />
              <span className={`text-xs font-medium ${currentWindow.status === "active" ? "text-[var(--accent-green)]" : "text-[var(--text-muted)]"}`}>
                {currentWindow.status === "active" ? "ACTIVE" : "EXPIRED"}
              </span>
            </div>
          ) : null}
        </div>

        {!currentWindow ? (
          <p className="text-[var(--text-muted)] text-sm">No data — requires active usage window</p>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3 text-xs">
              <span className="text-[var(--text-muted)]">
                {formatShortDate(currentWindow.startTime)} {formatLocalTime(currentWindow.startTime)} → {formatLocalTime(currentWindow.endTime)}
              </span>
              <span className="text-[var(--accent-orange)] font-mono font-medium">
                {windowRemaining > 0 ? `Resets in ${formatTimeRemaining(windowRemaining)}` : "Window expired"}
              </span>
            </div>
            <TokenBreakdown
              inputTokens={currentWindow.inputTokens}
              outputTokens={currentWindow.outputTokens}
              cacheCreationTokens={currentWindow.cacheCreationTokens}
              cacheReadTokens={currentWindow.cacheReadTokens}
              totalTokens={currentWindow.totalTokens}
              totalCost={currentWindow.totalCost}
              solvedLimits={solvedLimits}
              derivedLimits={derivedLimits}
              scope="5h"
              peakStatus={currentWindow.peakStatus}
              peakSplit={currentWindow.peakSplit}
              windowStart={currentWindow.startTime}
              planMultiplier={currentWindowPlanMult}
              promoPeriods={promoPeriods}
              overrides={windowOv}
              onOverride={makeOverrideHandler(setWindowOv)}
            />
            {currentWindowInsight && (
              <ValidationSummary
                estimatedPct={currentWindowInsight.estimatedPct}
                observedPct={currentWindowInsight.observedPct}
                deltaPct={currentWindowInsight.deltaPct}
                noPromoPct={currentWindowInsight.noPromoPct}
                observedAt={currentWindowInsight.observedAt}
              />
            )}
          </>
        )}
      </div>

      {/* Card 2: Current Week ALL */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">Current Week ALL</h3>
          {currentWeekAll && weekRemaining > 0 ? (
            <span className="text-xs text-[var(--accent-orange)] font-mono">
              Resets in {formatTimeRemaining(weekRemaining)}
            </span>
          ) : null}
        </div>

        {!currentWeekAll ? (
          <p className="text-[var(--text-muted)] text-sm">No data — requires active usage window</p>
        ) : (
          <>
            <div className="text-xs text-[var(--text-muted)] mb-3">
              {formatWeekRange(currentWeekAll.weekStart, currentWeekAll.weekEnd)}
            </div>
            <TokenBreakdown
              inputTokens={currentWeekAll.inputTokens}
              outputTokens={currentWeekAll.outputTokens}
              cacheCreationTokens={currentWeekAll.cacheCreationTokens}
              cacheReadTokens={currentWeekAll.cacheReadTokens}
              totalTokens={currentWeekAll.totalTokens}
              totalCost={currentWeekAll.totalCost}
              solvedLimits={solvedLimits}
              derivedLimits={derivedLimits}
              scope="weekly-all"
              peakStatus={currentWeekAll.peakStatus ?? "peak"}
              peakSplit={currentWeekAll.peakSplit}
              windowStart={currentWeekAll.weekStart}
              planMultiplier={currentWeekPlanMult}
              promoPeriods={promoPeriods}
              overrides={weekAllOv}
              onOverride={makeOverrideHandler(setWeekAllOv)}
            />
            {currentWeekInsight && (
              <ValidationSummary
                estimatedPct={currentWeekInsight.estimatedPct}
                observedPct={currentWeekInsight.observedPct}
                deltaPct={currentWeekInsight.deltaPct}
                noPromoPct={currentWeekInsight.noPromoPct}
                observedAt={currentWeekInsight.observedAt}
              />
            )}
          </>
        )}
      </div>

      {/* Card 3: Current Week Sonnet */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">Current Week SNNT</h3>
          {currentWeekSonnet && weekSonnetRemaining > 0 ? (
            <span className="text-xs text-[var(--accent-orange)] font-mono">
              Resets in {formatTimeRemaining(weekSonnetRemaining)}
            </span>
          ) : null}
        </div>

        {!currentWeekSonnet ? (
          <p className="text-[var(--text-muted)] text-sm">No Sonnet usage in current weekly cycle</p>
        ) : (
          <>
            <div className="text-xs text-[var(--text-muted)] mb-3">
              {formatWeekRange(currentWeekSonnet.weekStart, currentWeekSonnet.weekEnd)}
            </div>
            <TokenBreakdown
              inputTokens={currentWeekSonnet.inputTokens}
              outputTokens={currentWeekSonnet.outputTokens}
              cacheCreationTokens={currentWeekSonnet.cacheCreationTokens}
              cacheReadTokens={currentWeekSonnet.cacheReadTokens}
              totalTokens={currentWeekSonnet.totalTokens}
              totalCost={currentWeekSonnet.totalCost}
              solvedLimits={solvedLimits}
              derivedLimits={derivedLimits}
              scope="weekly-sonnet"
              peakStatus={currentWeekSonnet.peakStatus ?? "peak"}
              peakSplit={currentWeekSonnet.peakSplit}
              windowStart={currentWeekSonnet.weekStart}
              planMultiplier={currentWeekSonnetPlanMult}
              promoPeriods={promoPeriods}
              overrides={weekSonnetOv}
              onOverride={makeOverrideHandler(setWeekSonnetOv)}
            />
            {currentWeekSonnetInsight && (
              <ValidationSummary
                estimatedPct={currentWeekSonnetInsight.estimatedPct}
                observedPct={currentWeekSonnetInsight.observedPct}
                deltaPct={currentWeekSonnetInsight.deltaPct}
                noPromoPct={currentWeekSonnetInsight.noPromoPct}
                observedAt={currentWeekSonnetInsight.observedAt}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Session pressure (REQ-015) ───────────────────────────────────────────────

interface SessionPressurePanelProps {
  sessions: SessionStats[];
  currentWindow: FiveHourWindow | null;
  currentWeekAll: WeeklyBucket | null;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  planPeriods?: PlanPeriod[];
  promoPeriods?: PromoPeriod[];
}

interface SessionPressureRow {
  session: SessionStats;
  in5h: boolean;
  inWeekly: boolean;
  impact5hPct: number | null;
  impactWeeklyPct: number | null;
  driver: "input" | "output" | "cache create" | "cache read" | "mixed";
  modelMix: string;
}

function overlapsRange(startIso: string, endIso: string, rangeStartIso: string, rangeEndIso: string): boolean {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const rangeStart = new Date(rangeStartIso).getTime();
  const rangeEnd = new Date(rangeEndIso).getTime();
  if (![start, end, rangeStart, rangeEnd].every(Number.isFinite)) return false;
  return start <= rangeEnd && end >= rangeStart;
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

function modelMixLabel(models: Record<string, number>): string {
  const entries = Object.entries(models).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "unknown";
  return entries.slice(0, 2).map(([model, count]) => `${model} ${count}`).join(" / ");
}

function pressureDriver(session: SessionStats): SessionPressureRow["driver"] {
  const parts = [
    ["input", session.inputTokens],
    ["output", session.outputTokens],
    ["cache create", session.cacheCreationTokens],
    ["cache read", session.cacheReadTokens],
  ] as const;
  const sorted = [...parts].sort((a, b) => b[1] - a[1]);
  const total = parts.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return "mixed";
  if (sorted[0][1] / total < 0.45) return "mixed";
  return sorted[0][0];
}

function pressureState(impact5hPct: number | null, impactWeeklyPct: number | null): string {
  const five = impact5hPct ?? 0;
  const week = impactWeeklyPct ?? 0;
  if (five < 1 && week < 1) return "low pressure";
  if (five >= 10 && week >= 10) return "both constrained";
  if (five >= week * 1.5 && five >= 3) return "5h constrained";
  if (week >= five * 1.5 && week >= 3) return "weekly constrained";
  return "balanced pressure";
}

function sessionUsage(session: SessionStats) {
  return {
    outputTokens: session.outputTokens,
    inputTokens: session.inputTokens,
    cacheCreationTokens: session.cacheCreationTokens,
    cacheReadTokens: session.cacheReadTokens,
    totalTokens: session.totalTokens,
    totalCost: session.totalCost,
    peakStatus: "peak" as const,
    windowStart: session.startTime,
  };
}

function SessionPressurePanel({
  sessions,
  currentWindow,
  currentWeekAll,
  solvedLimits,
  derivedLimits,
  calibrations,
  planPeriods = EMPTY_PLAN_PERIODS,
  promoPeriods = EMPTY_PROMO_PERIODS,
}: SessionPressurePanelProps) {
  const currentWindowIds = new Set(currentWindow?.sessionIds ?? []);
  const windowPlanTier = currentWindow
    ? getPlanTierForDate(currentWindow.startTime, planPeriods)
    : null;
  const weekPlanTier = currentWeekAll
    ? getPlanTierForDate(currentWeekAll.weekStart, planPeriods)
    : null;
  const windowPlanMult = getDisplayPlanMultiplier(windowPlanTier, solvedLimits, "5h");
  const weekPlanMult = getDisplayPlanMultiplier(weekPlanTier, solvedLimits, "weekly-all");
  const currentWindowAnchor = currentWindow
    ? findCalibrationAnchor(calibrations, "5h", currentWindow.startTime)
    : undefined;
  const currentWeekAnchor = currentWeekAll
    ? findCalibrationAnchor(calibrations, "weekly-all", currentWeekAll.weekStart)
    : undefined;
  const currentWindowInsight = currentWindow
    ? computeLimitInsight({
        scope: "5h",
        usage: {
          outputTokens: currentWindow.outputTokens,
          inputTokens: currentWindow.inputTokens,
          cacheCreationTokens: currentWindow.cacheCreationTokens,
          cacheReadTokens: currentWindow.cacheReadTokens,
          totalTokens: currentWindow.totalTokens,
          totalCost: currentWindow.totalCost,
          peakStatus: currentWindow.peakStatus,
          peakSplit: currentWindow.peakSplit,
          windowStart: currentWindow.startTime,
        },
        solvedLimits,
        derivedLimits,
        promos: promoPeriods,
        planMultiplier: windowPlanMult,
        observedPoint: currentWindowAnchor,
      })
    : null;
  const currentWeekInsight = currentWeekAll
    ? computeLimitInsight({
        scope: "weekly-all",
        usage: {
          outputTokens: currentWeekAll.outputTokens,
          inputTokens: currentWeekAll.inputTokens,
          cacheCreationTokens: currentWeekAll.cacheCreationTokens,
          cacheReadTokens: currentWeekAll.cacheReadTokens,
          totalTokens: currentWeekAll.totalTokens,
          totalCost: currentWeekAll.totalCost,
          peakStatus: currentWeekAll.peakStatus ?? "peak",
          peakSplit: currentWeekAll.peakSplit,
          windowStart: currentWeekAll.weekStart,
        },
        solvedLimits,
        derivedLimits,
        promos: promoPeriods,
        planMultiplier: weekPlanMult,
        observedPoint: currentWeekAnchor,
      })
    : null;

  const rows = sessions
    .map((session): SessionPressureRow | null => {
      const in5h = currentWindowIds.has(session.sessionId);
      const inWeekly = currentWeekAll
        ? overlapsRange(session.startTime, session.endTime, currentWeekAll.weekStart, currentWeekAll.weekEnd)
        : false;
      if (!in5h && !inWeekly) return null;

      const impact5h = in5h
        ? computeLimitInsight({
            scope: "5h",
            usage: sessionUsage(session),
            solvedLimits,
            derivedLimits,
            promos: promoPeriods,
            planMultiplier: windowPlanMult,
          }).estimatedPct
        : null;
      const impactWeekly = inWeekly
        ? computeLimitInsight({
            scope: "weekly-all",
            usage: sessionUsage(session),
            solvedLimits,
            derivedLimits,
            promos: promoPeriods,
            planMultiplier: weekPlanMult,
          }).estimatedPct
        : null;

      return {
        session,
        in5h,
        inWeekly,
        impact5hPct: impact5h,
        impactWeeklyPct: impactWeekly,
        driver: pressureDriver(session),
        modelMix: modelMixLabel(session.models),
      };
    })
    .filter((row): row is SessionPressureRow => row != null)
    .sort(
      (a, b) =>
        Math.max(b.impact5hPct ?? 0, b.impactWeeklyPct ?? 0) -
        Math.max(a.impact5hPct ?? 0, a.impactWeeklyPct ?? 0)
    )
    .slice(0, 12);

  const state = pressureState(
    currentWindowInsight?.estimatedPct ?? null,
    currentWeekInsight?.estimatedPct ?? null
  );

  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">
            Session Limit Pressure
          </h3>
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Per-session cost proxy contribution to the active 5h and weekly scopes.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <span className="px-2 py-1 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
            5h est. {formatPct(currentWindowInsight?.estimatedPct ?? null)}
          </span>
          <span className="px-2 py-1 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
            Weekly est. {formatPct(currentWeekInsight?.estimatedPct ?? null)}
          </span>
          <span className="px-2 py-1 rounded bg-[var(--accent-orange)]/10 text-[var(--accent-orange)]">
            {state}
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          No active sessions in the current 5h or weekly scope.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
                <th className="text-left py-2 pr-3 font-medium">Session</th>
                <th className="text-left py-2 px-3 font-medium">Project</th>
                <th className="text-left py-2 px-3 font-medium">Model mix</th>
                <th className="text-right py-2 px-3 font-medium">Cost proxy</th>
                <th className="text-right py-2 px-3 font-medium">5h impact</th>
                <th className="text-right py-2 px-3 font-medium">Weekly impact</th>
                <th className="text-left py-2 pl-3 font-medium">Driver</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.session.sessionId}
                  className="border-b border-[var(--border-subtle)] last:border-0 text-[var(--text-secondary)]"
                >
                  <td className="py-2 pr-3 font-mono text-[11px]" title={row.session.sessionId}>
                    {shortSessionId(row.session.sessionId)}
                    <div className="text-[10px] text-[var(--text-muted)] font-sans">
                      {formatShortDate(row.session.startTime)} {formatLocalTime(row.session.startTime)}-{formatLocalTime(row.session.endTime)}
                    </div>
                  </td>
                  <td className="py-2 px-3 max-w-36 truncate" title={row.session.project}>
                    {row.session.project || "unknown"}
                  </td>
                  <td className="py-2 px-3 max-w-48 truncate" title={row.modelMix}>
                    {row.modelMix}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {formatCost(row.session.totalCost)}
                    <div className="text-[10px] text-[var(--text-muted)]">
                      {formatTokens(row.session.totalTokens)}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {row.in5h ? formatPct(row.impact5hPct) : "—"}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {row.inWeekly ? formatPct(row.impactWeeklyPct) : "—"}
                  </td>
                  <td className="py-2 pl-3">
                    <span className="px-2 py-0.5 rounded bg-[var(--bg-secondary)] text-[10px] uppercase tracking-wide">
                      {row.driver}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Weekly Accordion (Section B) ────────────────────────────────────────────

interface WeeklyAccordionProps {
  buckets: WeeklyBucket[];
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  overrides: SessionOverrides;
  onSaveOverride: (type: "weekly" | "5h", key: string, start: string, end: string) => Promise<void>;
}

function WeeklyAccordion({ buckets, solvedLimits, derivedLimits, overrides, onSaveOverride }: WeeklyAccordionProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);

  const sorted = [...buckets].sort(
    (a, b) => new Date(b.weekStart).getTime() - new Date(a.weekStart).getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="card p-5 mb-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Weekly Sessions</h3>
        <p className="text-[var(--text-muted)] text-sm">No weekly data available</p>
      </div>
    );
  }

  return (
    <div className="card p-5 mb-4">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">Weekly Sessions</h3>
      <div className="space-y-2">
        {sorted.map((bucket) => {
          const weekKey = isoWeekKey(bucket.weekStart);
          const override = overrides.weekly[weekKey];
          const isExpanded = expanded === weekKey;
          const isCurrentWeek = bucket.timeRemainingMs > 0;

          return (
            <div key={weekKey} className="border border-[var(--border-subtle)] rounded-lg overflow-hidden">
              {/* Accordion header */}
              <button
                onClick={() => setExpanded(isExpanded ? null : weekKey)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-secondary)] transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-[var(--accent-purple)]">{weekKey}</span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {override
                      ? `${formatLocalDate(override.start)} – ${formatLocalDate(override.end)}`
                      : formatWeekRange(bucket.weekStart, bucket.weekEnd)}
                  </span>
                  {override && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]">
                      corrected
                    </span>
                  )}
                  {isCurrentWeek && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-green)]/20 text-[var(--accent-green)]">
                      current
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-xs text-[var(--text-secondary)] tabular-nums flex flex-col items-end leading-tight">
                    <span>{formatTokens(bucket.totalTokens)}</span>
                    <span className="text-[9px] text-[var(--text-muted)]">{formatCost(bucket.totalCost)}</span>
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </button>

              {/* Accordion body */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-2 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
                  <TokenBreakdown
                    inputTokens={bucket.inputTokens}
                    outputTokens={bucket.outputTokens}
                    cacheCreationTokens={bucket.cacheCreationTokens}
                    cacheReadTokens={bucket.cacheReadTokens}
                    totalTokens={bucket.totalTokens}
                    totalCost={bucket.totalCost}
                    solvedLimits={solvedLimits}
                    derivedLimits={derivedLimits}
                    scope="weekly-all"
                    peakStatus="off-peak"
                    windowStart={bucket.weekStart}
                  />

                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
                    <span>{bucket.messageCount} msgs</span>
                    <span>{formatCost(bucket.totalCost)}</span>
                    <button
                      onClick={() => setEditKey(weekKey)}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[var(--text-muted)] border border-[var(--border-subtle)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue)] transition-colors"
                    >
                      Edit window boundaries
                    </button>
                  </div>
                </div>
              )}

              {/* Edit dialog */}
              {editKey === weekKey && (
                <EditBoundariesDialog
                  type="weekly"
                  overrideKey={weekKey}
                  initialStart={override?.start ?? bucket.weekStart}
                  initialEnd={override?.end ?? bucket.weekEnd}
                  onSave={(start, end) => onSaveOverride("weekly", weekKey, start, end)}
                  onClose={() => setEditKey(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 5h Windows Accordion (Section C) ────────────────────────────────────────

interface FiveHourAccordionProps {
  windows: FiveHourWindow[];
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  overrides: SessionOverrides;
  onSaveOverride: (type: "weekly" | "5h", key: string, start: string, end: string) => Promise<void>;
  promoPeriods?: PromoPeriod[];
}

function FiveHourAccordion({ windows, solvedLimits, derivedLimits, overrides, onSaveOverride, promoPeriods = EMPTY_PROMO_PERIODS }: FiveHourAccordionProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);

  const sorted = [...windows].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );

  if (sorted.length === 0) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">5h Windows</h3>
        <p className="text-[var(--text-muted)] text-sm">No window data available</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">5h Windows</h3>
      <div className="space-y-2">
        {sorted.map((win) => {
          const winKey = win.startTime;
          const override = overrides["5h"][winKey];
          const isExpanded = expanded === winKey;
          const displayStart = override?.start ?? win.startTime;
          const displayEnd = override?.end ?? win.endTime;

          return (
            <div key={winKey} className="border border-[var(--border-subtle)] rounded-lg overflow-hidden">
              {/* Accordion header */}
              <button
                onClick={() => setExpanded(isExpanded ? null : winKey)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-secondary)] transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-[var(--text-muted)] whitespace-nowrap">
                    {formatLocalTime(displayStart)} → {formatLocalTime(displayEnd)}
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {formatLocalDate(win.startTime)}
                  </span>
                  {override && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]">
                      corrected
                    </span>
                  )}
                  {win.status === "active" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-green)]/20 text-[var(--accent-green)] flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-green)] animate-pulse inline-block" />
                      active
                    </span>
                  )}
                  {win.peakStatus === "peak" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-red)]/20 text-[var(--accent-red)]">
                      peak
                    </span>
                  )}
                  {getWindowPromoMultiplier(win, promoPeriods) > 1 && win.peakStatus === "off-peak" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]">
                      promo
                    </span>
                  )}
                  {getWindowPromoMultiplier(win, promoPeriods) < 1 && win.peakStatus === "off-peak" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-red)]/20 text-[var(--accent-red)]">
                      reduced
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-xs text-[var(--text-secondary)] tabular-nums flex flex-col items-end leading-tight">
                    <span>{formatTokens(win.totalTokens)}</span>
                    <span className="text-[9px] text-[var(--text-muted)]">{formatCost(win.totalCost)}</span>
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </button>

              {/* Accordion body */}
              {isExpanded && (
                <div className="px-4 pb-4 pt-2 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
                  <TokenBreakdown
                    inputTokens={win.inputTokens}
                    outputTokens={win.outputTokens}
                    cacheCreationTokens={win.cacheCreationTokens}
                    cacheReadTokens={win.cacheReadTokens}
                    totalTokens={win.totalTokens}
                    totalCost={win.totalCost}
                    solvedLimits={solvedLimits}
                    derivedLimits={derivedLimits}
                    scope="5h"
                    peakStatus={win.peakStatus}
                    windowStart={win.startTime}
                  />

                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
                    <span>{win.messageCount} msgs / {win.sessionIds.length} sessions</span>
                    <div className="flex items-center gap-3">
                      <span>{formatCost(win.totalCost)}</span>
                      <button
                        onClick={() => setEditKey(winKey)}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[var(--text-muted)] border border-[var(--border-subtle)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue)] transition-colors"
                      >
                        Edit window boundaries
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Edit dialog */}
              {editKey === winKey && (
                <EditBoundariesDialog
                  type="5h"
                  overrideKey={winKey}
                  initialStart={override?.start ?? win.startTime}
                  initialEnd={override?.end ?? win.endTime}
                  onSave={(start, end) => onSaveOverride("5h", winKey, start, end)}
                  onClose={() => setEditKey(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── WeeklyWindowsView — weekly accordion (open by default) with 5h progress bars ──

type ViewMode = "output" | "total";

interface WindowRowProps {
  win: FiveHourWindow;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  overrides: SessionOverrides;
  onEditBoundaries: (winKey: string) => void;
  viewMode: ViewMode;
  maxTokens: number;
  promoPeriods?: PromoPeriod[];
  planMultiplier?: number;
  calibrationSeries?: CalibrationPoint[];
  calibrationAnchor?: CalibrationPoint;
}

function WindowRow({
  win,
  solvedLimits,
  derivedLimits,
  calibrations,
  overrides,
  onEditBoundaries,
  viewMode,
  maxTokens,
  promoPeriods = EMPTY_PROMO_PERIODS,
  planMultiplier = 1,
  calibrationSeries = [],
  calibrationAnchor,
}: WindowRowProps) {
  const [expanded, setExpanded] = useState(false);

  const override = overrides["5h"][win.startTime];
  const displayStart = override?.start ?? win.startTime;
  const displayEnd = override?.end ?? win.endTime;
  const calibrationPoint = calibrationAnchor ?? getCalibrationForWindow(win.id, calibrations);
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
    solvedLimits,
    derivedLimits,
    promos: promoPeriods,
    planMultiplier,
    calibrationSeries,
    calibrationAnchor,
    observedPoint: calibrationPoint,
  });

  // Compute utilization
  let displayPct: number | null = insight.estimatedPct;
  let bottleneckColor = "var(--accent-blue)";
  let bottleneckLabel = "";
  const isCalibrated = !!calibrationPoint;
  const basePct = insight.noPromoPct;

  if (insight.bottleneck) {
    bottleneckColor =
      BOTTLENECK_COLORS[insight.bottleneck as keyof typeof BOTTLENECK_COLORS] ??
      "var(--accent-blue)";
    bottleneckLabel =
      BOTTLENECK_LABELS[insight.bottleneck as keyof typeof BOTTLENECK_LABELS] ?? "";
  }

  const tokens = viewMode === "output" ? win.outputTokens : win.totalTokens;
  const barWidth = displayPct !== null
    ? Math.min(displayPct, 100)
    : (tokens / maxTokens) * 100;

  const barColor = win.status === "active"
    ? "var(--accent-green)"
    : win.peakStatus === "peak"
    ? "var(--accent-red)"
    : "var(--accent-blue)";

  return (
    <div className="border-b border-[var(--border-subtle)] last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-2.5 hover:bg-[var(--bg-secondary)]/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {/* Date + Time */}
          <span className="w-32 text-[11px] text-[var(--text-muted)] tabular-nums shrink-0 flex flex-col leading-tight">
            <span className="text-[9px] opacity-70">{formatShortDate(displayStart)}</span>
            <span>{formatLocalTime(displayStart)}–{formatLocalTime(displayEnd)}</span>
          </span>

          {/* Progress bar */}
          <div className="flex-1 h-5 bg-[var(--bg-primary)] rounded overflow-hidden relative">
            {insight.promoActive && displayPct !== null && basePct !== null ? (
              <>
                <div
                  className="absolute inset-y-0 left-0 rounded-l transition-all duration-300"
                  style={{ width: `${Math.max(barWidth, 2)}%`, background: barColor, opacity: 0.85 }}
                />
                <div
                  className="absolute inset-y-0 transition-all duration-300"
                  style={{
                    left: `${barWidth}%`,
                    width: `${Math.max(0, Math.min(basePct - barWidth, 100 - barWidth))}%`,
                    background: barColor,
                    opacity: 0.3,
                  }}
                />
              </>
            ) : (
              <div
                className="h-full rounded transition-all duration-300"
                style={{ width: `${Math.max(barWidth, 2)}%`, background: barColor, opacity: 0.8 }}
              />
            )}
          </div>

          {/* % label */}
          {displayPct !== null ? (
            <span
              className="w-32 text-right text-[11px] tabular-nums shrink-0 font-medium"
              style={{ color: bottleneckColor }}
            >
              {isCalibrated && <span className="text-[8px] text-[var(--accent-green)] mr-0.5">●</span>}
              {insight.promoActive && basePct !== null ? (
                <>
                  {displayPct.toFixed(0)}%{" "}
                  <span className="text-[var(--accent-orange)]">
                    ({basePct.toFixed(0)}%<span className="text-[9px]"> no promo</span>)
                  </span>
                </>
              ) : (
                <>
                  {displayPct.toFixed(0)}%
                  <span className="text-[9px] opacity-70 ml-0.5">{bottleneckLabel}</span>
                </>
              )}
            </span>
          ) : (
            <span className="w-32 text-right text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
              {formatTokens(tokens)}
            </span>
          )}

          <span className="w-24 text-right text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0 flex flex-col leading-tight">
            <span>{formatTokens(tokens)}</span>
            <span className="text-[9px] text-[var(--text-muted)]">{formatCost(win.totalCost)}</span>
          </span>
        </div>
      </button>

      {expanded && (
        <div className="ml-4 px-4 pb-3 pt-1 bg-[var(--bg-secondary)]/40 animate-fade-in">
          <TokenBreakdown
            inputTokens={win.inputTokens}
            outputTokens={win.outputTokens}
            cacheCreationTokens={win.cacheCreationTokens}
            cacheReadTokens={win.cacheReadTokens}
            totalTokens={win.totalTokens}
            totalCost={win.totalCost}
            solvedLimits={solvedLimits}
            derivedLimits={derivedLimits}
            scope="5h"
            peakStatus={win.peakStatus}
            peakSplit={win.peakSplit}
            windowStart={win.startTime}
            promoPeriods={promoPeriods}
            planMultiplier={planMultiplier}
          />
          <ValidationSummary
            estimatedPct={insight.estimatedPct}
            observedPct={insight.observedPct}
            deltaPct={insight.deltaPct}
            noPromoPct={insight.noPromoPct}
            observedAt={insight.observedAt}
          />

          {/* Meta row */}
          <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] pt-2 border-t border-[var(--border-subtle)]">
            <span>
              {win.messageCount} msgs / {win.sessionIds.length} sessions
              {override && <span className="ml-2 text-[var(--accent-orange)]">· boundary corrected</span>}
            </span>
            <div className="flex items-center gap-3">
              <span>{formatTokens(win.totalTokens)} total · {formatCost(win.totalCost)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onEditBoundaries(win.startTime); }}
                className="px-2 py-1 rounded text-[10px] border border-[var(--border-subtle)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue)] transition-colors"
              >
                Edit boundaries
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface WeeklyWindowsViewProps {
  windows: FiveHourWindow[];
  weeklyAll: WeeklyBucket[];
  weeklySonnet: WeeklyBucket[];
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  overrides: SessionOverrides;
  onSaveOverride: (type: "weekly" | "5h", key: string, start: string, end: string) => Promise<void>;
  planPeriods?: PlanPeriod[];
  promoPeriods?: PromoPeriod[];
}

/** Monday 00:00 – Sunday 23:59 (local time) for the ISO week containing dateStr */
function getWeekDateRange(dateStr: string): { start: Date; end: Date } {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day + 1);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 0, 0);
  return { start: monday, end: sunday };
}

function WeeklyWindowsView({
  windows,
  weeklyAll,
  weeklySonnet,
  solvedLimits,
  derivedLimits,
  calibrations,
  overrides,
  onSaveOverride,
  planPeriods = EMPTY_PLAN_PERIODS,
  promoPeriods = EMPTY_PROMO_PERIODS,
}: WeeklyWindowsViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("output");
  const [editKey, setEditKey] = useState<string | null>(null);
  const promoActiveNowLocal = promoPeriods.length > 0
    ? getActivePromoMultiplier(new Date().toISOString(), promoPeriods) !== 1
    : isInPromoRange(new Date().toISOString());
  const sorted = [...windows].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const maxTokens = Math.max(
    ...sorted.map((w) => (viewMode === "output" ? w.outputTokens : w.totalTokens)),
    1
  );

  const overlapMs = (
    aStart: string,
    aEnd: string,
    bStart: string,
    bEnd: string
  ): number => {
    const start = Math.max(new Date(aStart).getTime(), new Date(bStart).getTime());
    const end = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
    return Math.max(0, end - start);
  };

  const computeBucketEstimate = (
    bucket: WeeklyBucket | null,
    scope: "weekly-all" | "weekly-sonnet",
    planMult: number = 1,
    series: CalibrationPoint[] = [],
    anchor?: CalibrationPoint
  ): {
    displayPct: number;
    noPromoPct: number | null;
    color: string;
    label: string;
    observedPct: number | null;
    deltaPct: number | null;
    observedAt: string | null;
    historicalPromoInCycle: boolean;
  } | null => {
    if (!bucket) return null;

    const nowIso = new Date().toISOString();
    const promoActiveNow = promoPeriods.length > 0
      ? getActivePromoMultiplier(nowIso, promoPeriods) !== 1
      : isInPromoRange(nowIso);
    const hasPromoUsageInBucket = (bucket.peakSplit?.offPeak.totalTokens ?? 0) > 0;

    const insight = computeLimitInsight({
      scope,
      usage: {
        outputTokens: bucket.outputTokens,
        inputTokens: bucket.inputTokens,
        cacheCreationTokens: bucket.cacheCreationTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        totalTokens: bucket.totalTokens,
        totalCost: bucket.totalCost,
        peakStatus: bucket.peakStatus ?? "peak",
        peakSplit: bucket.peakSplit,
        windowStart: bucket.weekStart,
      },
      solvedLimits,
      derivedLimits,
      promos: promoPeriods,
      planMultiplier: planMult,
      calibrationSeries: series,
      calibrationAnchor: anchor,
      observedPoint: anchor,
    });

    if (insight.estimatedPct == null) return null;

    return {
      displayPct: insight.estimatedPct,
      noPromoPct: insight.noPromoPct,
      color:
        BOTTLENECK_COLORS[insight.bottleneck as keyof typeof BOTTLENECK_COLORS] ??
        "var(--accent-orange)",
      label:
        BOTTLENECK_LABELS[insight.bottleneck as keyof typeof BOTTLENECK_LABELS] ??
        "",
      observedPct: insight.observedPct,
      deltaPct: insight.deltaPct,
      observedAt: insight.observedAt,
      historicalPromoInCycle:
        hasPromoUsageInBucket &&
        bucket.timeRemainingMs > 0 &&
        !promoActiveNow,
    };
  };

  const groups = [...weeklyAll]
    .sort(
      (a, b) => new Date(b.weekStart).getTime() - new Date(a.weekStart).getTime()
    )
    .map((allBucket) => {
      const wins = sorted.filter((win) => {
        const start = new Date(win.startTime).getTime();
        return (
          start >= new Date(allBucket.weekStart).getTime() &&
          start < new Date(allBucket.weekEnd).getTime()
        );
      });

      const sonnetBucket =
        [...weeklySonnet].sort(
          (a, b) =>
            overlapMs(allBucket.weekStart, allBucket.weekEnd, b.weekStart, b.weekEnd) -
            overlapMs(allBucket.weekStart, allBucket.weekEnd, a.weekStart, a.weekEnd)
        )[0] ?? null;

      const weekPlanTier = planPeriods
        ? getPlanTierForDate(allBucket.weekStart, planPeriods)
        : null;
      const weekPlanInfo = weekPlanTier ? PLAN_TIERS[weekPlanTier] : null;
      const allOverride = getWeeklyOverrideMatch(overrides, allBucket, "all");
      const resolvedSonnetBucket =
        sonnetBucket &&
        overlapMs(
          allBucket.weekStart,
          allBucket.weekEnd,
          sonnetBucket.weekStart,
          sonnetBucket.weekEnd
        ) > 0
          ? sonnetBucket
          : null;
      const sonnetOverride = resolvedSonnetBucket
        ? getWeeklyOverrideMatch(overrides, resolvedSonnetBucket, "sonnet")
        : null;

      const weeklyAllPlanMult = getDisplayPlanMultiplier(weekPlanTier, solvedLimits, "weekly-all");
      const weeklySonnetPlanMult = getDisplayPlanMultiplier(weekPlanTier, solvedLimits, "weekly-sonnet");
      const windowPlanMult = getDisplayPlanMultiplier(weekPlanTier, solvedLimits, "5h");

      // Find calibration anchors for this week
      const allAnchor = findCalibrationAnchor(calibrations, "weekly-all", allBucket.weekStart);
      const allSeries = findCalibrationSeries(calibrations, "weekly-all", allBucket.weekStart);
      const sonnetAnchor = resolvedSonnetBucket
        ? findCalibrationAnchor(calibrations, "weekly-sonnet", resolvedSonnetBucket.weekStart)
        : undefined;
      const sonnetSeries = resolvedSonnetBucket
        ? findCalibrationSeries(calibrations, "weekly-sonnet", resolvedSonnetBucket.weekStart)
        : [];

      return {
        key: allBucket.weekStart,
        weekKey: weekKeyFromDate(allBucket.weekStart),
        sonnetWeekKey: resolvedSonnetBucket ? weekKeyFromDate(resolvedSonnetBucket.weekStart) : null,
        allBucket,
        sonnetBucket: resolvedSonnetBucket,
        wins,
        allEst: computeBucketEstimate(allBucket, "weekly-all", weeklyAllPlanMult, allSeries, allAnchor),
        sonnetEst: computeBucketEstimate(
          resolvedSonnetBucket,
          "weekly-sonnet",
          weeklySonnetPlanMult,
          sonnetSeries,
          sonnetAnchor
        ),
        weekPlanInfo,
        windowPlanMultiplier: windowPlanMult,
        allOverride,
        sonnetOverride,
      };
    })
    .filter((group) => group.wins.length > 0 || group.allBucket.timeRemainingMs > 0);

  const renderWeeklyBar = (
    tag: string,
    est: {
      displayPct: number;
      noPromoPct: number | null;
      color: string;
      label: string;
      observedPct: number | null;
      deltaPct: number | null;
      observedAt: string | null;
      historicalPromoInCycle: boolean;
    } | null
  ) => (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-6 bg-[var(--bg-primary)] rounded overflow-hidden relative">
        {est &&
          (est.noPromoPct !== null ? (
            <>
              <div
                className="absolute inset-y-0 left-0 rounded-l transition-all duration-300"
                style={{
                  width: `${Math.max(Math.min(est.displayPct, 100), 2)}%`,
                  background: est.color,
                  opacity: 0.8,
                }}
              />
              <div
                className="absolute inset-y-0 rounded-r transition-all duration-300"
                style={{
                  left: `${Math.max(Math.min(est.displayPct, 100), 2)}%`,
                  width: `${Math.max(
                    0,
                    Math.min(
                      (est.noPromoPct ?? 0) - Math.max(Math.min(est.displayPct, 100), 2),
                      100 - Math.max(Math.min(est.displayPct, 100), 2)
                    )
                  )}%`,
                  background: est.color,
                  opacity: 0.3,
                }}
              />
            </>
          ) : (
            <div
              className="h-full rounded transition-all duration-300"
              style={{
                width: `${Math.max(Math.min(est.displayPct, 100), 2)}%`,
                background: est.color,
                opacity: 0.75,
              }}
            />
          ))}
        <span className="absolute inset-y-0 left-2 flex items-center text-[9px] font-medium text-white/50 uppercase tracking-wider pointer-events-none">
          {tag}
        </span>
      </div>
      {est && (
        <span
          className="w-32 text-right text-[11px] font-semibold tabular-nums shrink-0"
          style={{ color: est.color }}
        >
          {est.noPromoPct !== null ? (
            <>
              {est.displayPct.toFixed(0)}%
              <span className="text-[var(--accent-orange)] ml-1">
                ({est.noPromoPct.toFixed(0)}%
                <span className="text-[9px]"> cycle no promo</span>)
              </span>
              {est.historicalPromoInCycle && (
                <span
                  className="text-[9px] ml-1 text-[var(--text-muted)]"
                  title="No promo dotyczy całego zakresu tygodniowego; ten cykl zawiera wcześniejsze godziny promocyjne, mimo że promo nie jest już aktywne teraz."
                >
                  past promo
                </span>
              )}
            </>
          ) : (
            <>
              {est.displayPct.toFixed(0)}%
              <span className="text-[9px] font-normal opacity-70 ml-0.5">
                {est.label}
              </span>
            </>
          )}
        </span>
      )}
    </div>
  );

  if (sorted.length === 0) {
    return (
      <div className="card p-5">
        <p className="text-[var(--text-muted)] text-sm">No window data available</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-[var(--text-secondary)]">
            Weekly Sessions + 5h Windows
          </h3>
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            `ALL` i `SNNT` mają osobne reset cycles. `Cycle no promo` dotyczy całego zakresu
            danego wiersza, nie tylko bieżącego dnia.
          </p>
        </div>
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

      <div className="space-y-3">
        {groups.map(
          ({
            key,
            weekKey,
            sonnetWeekKey,
            allBucket,
            sonnetBucket,
            wins,
            allEst,
            sonnetEst,
            weekPlanInfo,
            windowPlanMultiplier,
            allOverride,
            sonnetOverride,
          }) => {
            const isCollapsed = collapsed.has(key);
            const planAccentColor = weekPlanInfo?.color ?? null;

            return (
              <div
                key={key}
                className="border rounded-lg overflow-hidden"
                style={{
                  borderColor: planAccentColor
                    ? `color-mix(in srgb, ${planAccentColor} 35%, var(--border-subtle))`
                    : "var(--border-subtle)",
                }}
              >
                <button
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (isCollapsed) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-[var(--bg-secondary)] transition-colors text-left"
                  style={{
                    background: planAccentColor
                      ? `color-mix(in srgb, ${planAccentColor} 6%, var(--bg-secondary))`
                      : "color-mix(in srgb, var(--bg-secondary) 60%, transparent)",
                  }}
                >
                  <div className="flex flex-col shrink-0 w-36 leading-tight">
                    <div className="flex items-center gap-1">
                      <span
                        className="text-[9px] font-semibold tabular-nums"
                        style={{ color: planAccentColor ?? "var(--accent-purple)" }}
                      >
                        {weekKey}
                      </span>
                      {weekPlanInfo && (
                        <span
                          className="text-[9px] px-1 rounded font-semibold"
                          style={{
                            color: weekPlanInfo.color,
                            background: `color-mix(in srgb, ${weekPlanInfo.color} 18%, transparent)`,
                          }}
                        >
                          {weekPlanInfo.shortLabel}
                        </span>
                      )}
                      {sonnetWeekKey && sonnetWeekKey !== weekKey && (
                        <span
                          className="text-[9px] px-1 rounded font-medium text-[var(--accent-orange)]"
                          style={{
                            background:
                              "color-mix(in srgb, var(--accent-orange) 14%, transparent)",
                          }}
                          title={`ALL jest w cyklu ${weekKey}, a SNNT w cyklu ${sonnetWeekKey}. To są dwa różne tygodniowe zakresy resetu.`}
                        >
                          ALL/SNNT reset mismatch
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
                      ALL {formatWeekRange(allOverride?.entry.start ?? allBucket.weekStart, allOverride?.entry.end ?? allBucket.weekEnd)}
                    </span>
                    {sonnetBucket && (
                      <span className="text-[10px] text-[var(--text-muted)]/80 tabular-nums">
                        S {formatWeekRange(sonnetOverride?.entry.start ?? sonnetBucket.weekStart, sonnetOverride?.entry.end ?? sonnetBucket.weekEnd)}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 flex flex-col gap-1 min-w-0">
                    {renderWeeklyBar("ALL", allEst)}
                    {renderWeeklyBar("SNNT", sonnetEst)}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-1">
                    <span className="text-[11px] text-[var(--text-secondary)] tabular-nums flex flex-col items-end leading-tight">
                      <span>
                        {formatTokens(
                          viewMode === "output"
                            ? allBucket.outputTokens
                            : allBucket.totalTokens
                        )}
                      </span>
                      <span className="text-[9px] text-[var(--text-muted)]">
                        {formatCost(allBucket.totalCost)}
                      </span>
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {wins.length} win
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {isCollapsed ? "▶" : "▼"}
                    </span>
                  </div>
                </button>

                {!isCollapsed && (
                  <div>
                    {wins.map((win) => (
                      <WindowRow
                        key={win.id}
                        win={win}
                        solvedLimits={solvedLimits}
                        derivedLimits={derivedLimits}
                        calibrations={calibrations}
                        overrides={overrides}
                        onEditBoundaries={setEditKey}
                        viewMode={viewMode}
                        maxTokens={maxTokens}
                        promoPeriods={promoPeriods}
                        planMultiplier={windowPlanMultiplier}
                        calibrationSeries={findCalibrationSeries(calibrations, "5h", win.startTime)}
                        calibrationAnchor={findCalibrationAnchor(calibrations, "5h", win.startTime)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          }
        )}
      </div>

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
          Peak
        </span>
        <span className="border-l border-[var(--border-subtle)] pl-3 flex items-center gap-1">
          <span className="w-3 h-2 rounded-sm bg-[var(--accent-blue)]" style={{ opacity: 0.85 }} />
          <span className="w-3 h-2 rounded-sm bg-[var(--accent-blue)]" style={{ opacity: 0.3 }} />
          No promo overlay
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[var(--accent-green)]">●</span>
          Calibrated
        </span>
      </div>

      {editKey &&
        (() => {
          const win = windows.find((w) => w.startTime === editKey);
          if (!win) return null;
          const override = overrides["5h"][editKey];
          return (
            <EditBoundariesDialog
              type="5h"
              overrideKey={editKey}
              initialStart={override?.start ?? win.startTime}
              initialEnd={override?.end ?? win.endTime}
              onSave={(start, end) => onSaveOverride("5h", editKey, start, end)}
              onClose={() => setEditKey(null)}
            />
          );
        })()}
    </div>
  );
}

// ─── Quick Calibration (live cost override) ─────────────────────────────────

/** Build ad-hoc SolvedLimits from a cost value using default ratio between cost and tokens */
function solvedLimitsFromCost(costLimit5h: number, costLimitWeekly: number): Record<CalibrationScope, SolvedLimits> {
  const build = (cost: number, defaults: { outputLimit: number; inputOutputLimit: number; totalLimit: number; costLimit: number }, scope: CalibrationScope): SolvedLimits => {
    const ratio = defaults.costLimit > 0 ? cost / defaults.costLimit : 1;
    const best = {
      outputLimit: Math.round(defaults.outputLimit * ratio),
      inputOutputLimit: Math.round(defaults.inputOutputLimit * ratio),
      totalLimit: Math.round(defaults.totalLimit * ratio),
      costLimit: cost,
      confidence: 0.5,
    };
    return {
      methods: [{ method: "cost" as const, ...best, dataPoints: 1 }],
      best,
      weights: null,
      scope,
    };
  };

  // For Max $200 tier (multiplier 20)
  const mult = PLAN_TIERS.max20.multiplier;
  return {
    "5h": build(costLimit5h * mult, DEFAULT_LIMITS_5H, "5h"),
    "weekly-all": build(costLimitWeekly * mult, DEFAULT_LIMITS_WEEKLY, "weekly-all"),
    "weekly-sonnet": build(costLimitWeekly * mult, DEFAULT_LIMITS_WEEKLY, "weekly-sonnet"),
  };
}

interface QuickCalProps {
  cost5h: string;
  costWeekly: string;
  onChange: (field: "5h" | "weekly", value: string) => void;
  onReset: () => void;
  isActive: boolean;
}

function QuickCalSidebar({ cost5h, costWeekly, onChange, onReset, isActive }: QuickCalProps) {
  return (
    <div className={`sticky top-4 w-[100px] shrink-0 space-y-3 transition-all ${isActive ? "ring-1 ring-[var(--accent-orange)] rounded-xl p-2.5" : "p-2.5"}`}
      style={isActive ? { background: "color-mix(in srgb, var(--accent-orange) 5%, var(--bg-card))" } : undefined}
    >
      <div className="text-[9px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
        Quick Cal
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] text-[var(--text-muted)] block" htmlFor="qcal-5h">5h $</label>
        <input
          id="qcal-5h"
          type="number"
          step="0.5"
          placeholder={DEFAULT_LIMITS_5H.costLimit.toFixed(0)}
          value={cost5h}
          onChange={(e) => onChange("5h", e.target.value)}
          className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded px-1.5 py-1.5 text-[11px] tabular-nums text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-orange)] transition-colors text-right"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] text-[var(--text-muted)] block" htmlFor="qcal-wk">Week $</label>
        <input
          id="qcal-wk"
          type="number"
          step="1"
          placeholder={DEFAULT_LIMITS_WEEKLY.costLimit.toFixed(0)}
          value={costWeekly}
          onChange={(e) => onChange("weekly", e.target.value)}
          className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded px-1.5 py-1.5 text-[11px] tabular-nums text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-orange)] transition-colors text-right"
        />
      </div>

      {isActive && (
        <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
          <span className="text-[10px] text-[var(--accent-orange)] font-semibold block text-center">LIVE</span>
          <button
            onClick={onReset}
            className="w-full text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-red)] transition-colors text-center"
          >
            reset
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main LimitsTab Component ─────────────────────────────────────────────────

interface LimitsTabProps {
  limitsData: LimitsData;
  solvedLimits: Record<CalibrationScope, SolvedLimits> | null;
  derivedLimits: DerivedLimits | null;
  calibrations: CalibrationPoint[];
  sessions?: SessionStats[];
  planPeriods?: PlanPeriod[];
  promoPeriods?: PromoPeriod[];
}

export function LimitsTab({
  limitsData,
  solvedLimits,
  derivedLimits,
  calibrations,
  sessions = EMPTY_SESSIONS,
  planPeriods = EMPTY_PLAN_PERIODS,
  promoPeriods = EMPTY_PROMO_PERIODS,
}: LimitsTabProps) {
  const [overrides, setOverrides] = useState<SessionOverrides>({ weekly: {}, "5h": {} });

  // Quick Calibration state
  const [qcal5h, setQcal5h] = useState("");
  const [qcalWeekly, setQcalWeekly] = useState("");

  const qcal5hVal = parseFloat(qcal5h);
  const qcalWeeklyVal = parseFloat(qcalWeekly);
  const has5h = !isNaN(qcal5hVal) && qcal5hVal > 0;
  const hasWeekly = !isNaN(qcalWeeklyVal) && qcalWeeklyVal > 0;
  const qcalActive = has5h || hasWeekly;

  // Build effective limits: merge quick cal with original, only override filled scopes
  const effectiveSolvedLimits = (() => {
    if (!qcalActive) return solvedLimits;

    const adhoc = solvedLimitsFromCost(
      has5h ? qcal5hVal : DEFAULT_LIMITS_5H.costLimit,
      hasWeekly ? qcalWeeklyVal : DEFAULT_LIMITS_WEEKLY.costLimit
    );

    // Keep original solved limits for scopes the user didn't touch
    return {
      "5h": has5h ? adhoc["5h"] : (solvedLimits?.["5h"] ?? adhoc["5h"]),
      "weekly-all": hasWeekly ? adhoc["weekly-all"] : (solvedLimits?.["weekly-all"] ?? adhoc["weekly-all"]),
      "weekly-sonnet": hasWeekly ? adhoc["weekly-sonnet"] : (solvedLimits?.["weekly-sonnet"] ?? adhoc["weekly-sonnet"]),
    };
  })();

  const handleQcalChange = (field: "5h" | "weekly", value: string) => {
    if (field === "5h") setQcal5h(value);
    else setQcalWeekly(value);
  };

  const handleQcalReset = () => {
    setQcal5h("");
    setQcalWeekly("");
  };

  const fetchOverrides = useCallback(async () => {
    try {
      const res = await fetch("/api/session-overrides", { cache: "no-store" });
      if (res.ok) {
        setOverrides(await res.json());
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchOverrides();
  }, [fetchOverrides]);

  const handleSaveOverride = async (
    type: "weekly" | "5h",
    key: string,
    start: string,
    end: string
  ) => {
    await fetch("/api/session-overrides", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, key, start, end }),
    });
    await fetchOverrides();
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="card p-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
        <span><span className="font-semibold text-[var(--text-secondary)]">Est.</span> = model z JSONL + plan + promo</span>
        <span><span className="font-semibold text-[var(--text-secondary)]">Obs.</span> = snapshot z panelu Anthropic</span>
        <span><span className="font-semibold text-[var(--text-secondary)]">Δ</span> = Obs. - Est.</span>
        <span><span className="font-semibold text-[var(--text-secondary)]">No promo</span> = ten sam usage policzony bez bonusu promo</span>
      </div>

      <LimitRegimeEvidencePanel
        calibrations={calibrations}
        planPeriods={planPeriods}
      />

      {/* Section A: Status cards */}
      <StatusCards
        currentWindow={limitsData.currentWindow}
        currentWeekAll={limitsData.currentWeekAll}
        currentWeekSonnet={limitsData.currentWeekSonnet}
        solvedLimits={effectiveSolvedLimits}
        derivedLimits={derivedLimits}
        calibrations={calibrations}
        planPeriods={planPeriods}
        promoPeriods={promoPeriods}
      />

      <SessionPressurePanel
        sessions={sessions}
        currentWindow={limitsData.currentWindow}
        currentWeekAll={limitsData.currentWeekAll}
        solvedLimits={effectiveSolvedLimits}
        derivedLimits={derivedLimits}
        calibrations={calibrations}
        planPeriods={planPeriods}
        promoPeriods={promoPeriods}
      />

      {/* Section B+C: Bars + Quick Cal floating sidebar */}
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0">
          <WeeklyWindowsView
            windows={limitsData.windows}
            weeklyAll={limitsData.weeklyAll}
            weeklySonnet={limitsData.weeklySonnet}
            solvedLimits={effectiveSolvedLimits}
            derivedLimits={derivedLimits}
            calibrations={calibrations}
            overrides={overrides}
            onSaveOverride={handleSaveOverride}
            planPeriods={planPeriods}
            promoPeriods={promoPeriods}
          />
        </div>
        <QuickCalSidebar
          cost5h={qcal5h}
          costWeekly={qcalWeekly}
          onChange={handleQcalChange}
          onReset={handleQcalReset}
          isActive={qcalActive}
        />
      </div>
    </div>
  );
}
