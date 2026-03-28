"use client";

import { WeeklyBucket, DerivedLimits } from "@/lib/types";
import { formatTokens, formatCost } from "@/lib/format";
import {
  calcUtilization,
  BOTTLENECK_LABELS,
  BOTTLENECK_COLORS,
} from "@/lib/utilization";

interface Props {
  currentAll: WeeklyBucket | null;
  currentSonnet: WeeklyBucket | null;
  previousAll: WeeklyBucket[];
  previousSonnet: WeeklyBucket[];
  derivedLimits: DerivedLimits | null;
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "Reset";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatResetTime(iso: string): string {
  return new Date(iso).toLocaleString("pl-PL", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface WeeklyRowProps {
  label: string;
  current: WeeklyBucket | null;
  previous: WeeklyBucket | null;
  color: string;
  derivedLimits: DerivedLimits | null;
}

function WeeklyRow({
  label,
  current,
  previous,
  color,
  derivedLimits,
}: WeeklyRowProps) {
  if (!current) {
    return (
      <div className="p-4 bg-[var(--bg-secondary)] rounded-lg">
        <span className="text-xs text-[var(--text-muted)]">
          {label}: No data this week
        </span>
      </div>
    );
  }

  // Compare with previous week
  const prevTotal = previous?.totalTokens ?? 0;
  const changePercent =
    prevTotal > 0
      ? ((current.totalTokens - prevTotal) / prevTotal) * 100
      : 0;

  // Calculate utilization
  const util = calcUtilization(
    {
      outputTokens: current.outputTokens,
      inputTokens: current.inputTokens,
      totalTokens: current.totalTokens,
    },
    derivedLimits,
    "off-peak", // weekly doesn't have peak distinction per-se
    current.weekStart,
    "weekly"
  );

  return (
    <div className="p-4 bg-[var(--bg-secondary)] rounded-lg space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--text-secondary)]">
            {label}
          </span>
          {util && (
            <span
              className="text-xs font-medium tabular-nums px-1.5 py-0.5 rounded"
              style={{
                color: BOTTLENECK_COLORS[util.bottleneck],
                background: `color-mix(in srgb, ${BOTTLENECK_COLORS[util.bottleneck]} 15%, transparent)`,
              }}
            >
              {util.effectivePct.toFixed(0)}%
              <span className="text-[9px] opacity-70 ml-0.5">
                {BOTTLENECK_LABELS[util.bottleneck]}
              </span>
            </span>
          )}
        </div>
        <span className="text-xs text-[var(--accent-orange)] tabular-nums">
          Resets {formatResetTime(current.weekEnd)} (
          {formatTimeRemaining(current.timeRemainingMs)})
        </span>
      </div>

      {/* Token breakdown as mini bars */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="w-14 text-[10px] text-[var(--text-muted)] text-right">
            Output
          </span>
          <div className="flex-1 h-2.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${
                  current.totalTokens > 0
                    ? (current.outputTokens / current.totalTokens) * 100
                    : 0
                }%`,
                background: "var(--accent-green)",
              }}
            />
          </div>
          <span className="w-14 text-[10px] text-[var(--text-secondary)] tabular-nums text-right">
            {formatTokens(current.outputTokens)}
          </span>
          {util && (
            <span className="w-10 text-[9px] text-[var(--text-muted)] tabular-nums text-right">
              {util.outputPct.toFixed(0)}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="w-14 text-[10px] text-[var(--text-muted)] text-right">
            In+Out
          </span>
          <div className="flex-1 h-2.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${
                  current.totalTokens > 0
                    ? ((current.inputTokens + current.outputTokens) /
                        current.totalTokens) *
                      100
                    : 0
                }%`,
                background: "var(--accent-blue)",
              }}
            />
          </div>
          <span className="w-14 text-[10px] text-[var(--text-secondary)] tabular-nums text-right">
            {formatTokens(current.inputTokens + current.outputTokens)}
          </span>
          {util && (
            <span className="w-10 text-[9px] text-[var(--text-muted)] tabular-nums text-right">
              {util.inoutPct.toFixed(0)}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="w-14 text-[10px] text-[var(--text-muted)] text-right">
            Total
          </span>
          <div className="flex-1 h-2.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: "100%", background: color, opacity: 0.6 }}
            />
          </div>
          <span className="w-14 text-[10px] text-[var(--text-secondary)] tabular-nums text-right">
            {formatTokens(current.totalTokens)}
          </span>
          {util && (
            <span className="w-10 text-[9px] text-[var(--text-muted)] tabular-nums text-right">
              {util.totalPct.toFixed(0)}%
            </span>
          )}
        </div>
      </div>

      {/* Utilization detail */}
      {util && (
        <div className="flex items-center gap-3 text-[10px] pt-1 border-t border-[var(--border-subtle)]">
          <span className="text-[var(--text-muted)]">Bottleneck:</span>
          <span
            className="font-medium"
            style={{ color: BOTTLENECK_COLORS[util.bottleneck] }}
          >
            {util.bottleneck === "output"
              ? "Output tokens"
              : util.bottleneck === "inout"
              ? "Input+Output combined"
              : "Total (incl. cache)"}
          </span>
          <span className="text-[var(--text-muted)] ml-auto">
            {util.effectivePct.toFixed(1)}% of limit used
          </span>
        </div>
      )}

      {/* Summary */}
      <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
        <span>{current.messageCount} msgs this week</span>
        <span>{formatCost(current.totalCost)}</span>
        {previous && prevTotal > 0 && (
          <span
            className={
              changePercent >= 0
                ? "text-[var(--accent-red)]"
                : "text-[var(--accent-green)]"
            }
          >
            {changePercent >= 0 ? "+" : ""}
            {changePercent.toFixed(0)}% vs last week
          </span>
        )}
      </div>
    </div>
  );
}

export function WeeklyLimits({
  currentAll,
  currentSonnet,
  previousAll,
  previousSonnet,
  derivedLimits,
}: Props) {
  const prevAll =
    previousAll.length > 0 ? previousAll[previousAll.length - 1] : null;
  const prevSonnet =
    previousSonnet.length > 0
      ? previousSonnet[previousSonnet.length - 1]
      : null;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">
          Weekly Limits
        </h3>
        {!derivedLimits && (
          <span className="text-[10px] text-[var(--text-muted)]">
            Enter % in Calculator to enable utilization tracking
          </span>
        )}
      </div>
      <div className="space-y-3">
        <WeeklyRow
          label="All Models"
          current={currentAll}
          previous={prevAll}
          color="var(--accent-blue)"
          derivedLimits={derivedLimits}
        />
        <WeeklyRow
          label="Sonnet Only"
          current={currentSonnet}
          previous={prevSonnet}
          color="var(--accent-purple)"
          derivedLimits={derivedLimits}
        />
      </div>
    </div>
  );
}
