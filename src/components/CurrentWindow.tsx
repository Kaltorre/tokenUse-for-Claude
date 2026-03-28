"use client";

import { useEffect, useState } from "react";
import { FiveHourWindow } from "@/lib/types";
import { formatTokens, formatCost } from "@/lib/format";

interface Props {
  window: FiveHourWindow | null;
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface TokenBarProps {
  label: string;
  value: number;
  max: number;
  color: string;
}

function TokenBar({ label, value, max, color }: TokenBarProps) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-20 text-[var(--text-muted)] text-right">{label}</span>
      <div className="flex-1 h-3 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(pct, 100)}%`, background: color }}
        />
      </div>
      <span className="w-16 text-[var(--text-secondary)] tabular-nums">{formatTokens(value)}</span>
    </div>
  );
}

export function CurrentWindow({ window: win }: Props) {
  const [remaining, setRemaining] = useState(win?.timeRemainingMs ?? 0);

  useEffect(() => {
    if (!win || win.status !== "active") return;
    const endTime = new Date(win.endTime).getTime();
    const tick = () => setRemaining(Math.max(0, endTime - Date.now()));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [win]);

  if (!win) {
    return (
      <div className="card p-5">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">
          Current 5h Window
        </h3>
        <p className="text-[var(--text-muted)] text-sm">
          No active window — no recent usage detected
        </p>
      </div>
    );
  }

  const isActive = remaining > 0;
  const maxToken = win.totalTokens;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">
          Current 5h Window
        </h3>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              isActive ? "bg-[var(--accent-green)] animate-pulse" : "bg-[var(--text-muted)]"
            }`}
          />
          <span className={`text-xs font-medium ${
            isActive ? "text-[var(--accent-green)]" : "text-[var(--text-muted)]"
          }`}>
            {isActive ? "ACTIVE" : "EXPIRED"}
          </span>
        </div>
      </div>

      {/* Time info */}
      <div className="flex items-center justify-between mb-4 text-xs">
        <span className="text-[var(--text-muted)]">
          {formatLocalTime(win.startTime)} — {formatLocalTime(win.endTime)}
        </span>
        {isActive && (
          <span className="text-[var(--accent-orange)] font-medium tabular-nums">
            Resets in {formatTimeRemaining(remaining)}
          </span>
        )}
      </div>

      {/* Peak status badge */}
      {win.peakStatus !== "off-peak" && (
        <div className="mb-3">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
            win.peakStatus === "peak"
              ? "bg-[var(--accent-red)]/20 text-[var(--accent-red)]"
              : "bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]"
          }`}>
            {win.peakStatus === "peak" ? "PEAK HOURS" : "MIXED PEAK/OFF-PEAK"}
          </span>
        </div>
      )}

      {/* Token bars */}
      <div className="space-y-2">
        <TokenBar label="Output" value={win.outputTokens} max={maxToken} color="var(--accent-green)" />
        <TokenBar label="Input" value={win.inputTokens} max={maxToken} color="var(--accent-blue)" />
        <TokenBar label="Cache Write" value={win.cacheCreationTokens} max={maxToken} color="var(--accent-purple)" />
        <TokenBar label="Cache Read" value={win.cacheReadTokens} max={maxToken} color="var(--accent-cyan)" />
      </div>

      {/* Summary row */}
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--border-subtle)]">
        <div className="flex gap-4 text-xs text-[var(--text-muted)]">
          <span>{win.messageCount} msgs</span>
          <span>{win.sessionIds.length} sessions</span>
        </div>
        <div className="flex gap-3 text-xs">
          <span className="text-[var(--text-secondary)] font-medium tabular-nums">
            {formatTokens(win.totalTokens)} total
          </span>
          <span className="text-[var(--text-muted)]">{formatCost(win.totalCost)}</span>
        </div>
      </div>
    </div>
  );
}
