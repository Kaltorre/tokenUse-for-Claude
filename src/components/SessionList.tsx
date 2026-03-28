"use client";

import { useState } from "react";
import { SessionStats, DerivedLimits } from "@/lib/types";
import { formatTokens, formatCost, formatDateTime, formatDuration, shortProject } from "@/lib/format";

interface Props {
  sessions: SessionStats[];
  compact?: boolean;
  derivedLimits?: DerivedLimits | null;
}

export function SessionList({ sessions, compact, derivedLimits }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"time" | "tokens" | "cost">("time");
  const [page, setPage] = useState(0);
  const pageSize = compact ? sessions.length : 25;

  const sorted = [...sessions].sort((a, b) => {
    if (sortBy === "tokens") return b.totalTokens - a.totalTokens;
    if (sortBy === "cost") return b.totalCost - a.totalCost;
    return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
  });

  const paginated = compact ? sorted : sorted.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.ceil(sorted.length / pageSize);

  return (
    <div className="card p-5">
      <div className="mb-3">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">
          {compact ? "Recent Sessions" : `All Sessions (${sessions.length})`}
        </h3>
      </div>

      {!compact && (
        <div className="flex items-center justify-between px-3 pb-1.5 border-b border-[var(--border-subtle)] mb-1">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setSortBy("time")}
              className={`text-xs font-medium transition-colors ${
                sortBy === "time"
                  ? "text-[var(--accent-blue)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              time {sortBy === "time" && "↓"}
            </button>
            <span className="text-xs text-[var(--text-muted)] opacity-40">project</span>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <button
              onClick={() => setSortBy("tokens")}
              className={`text-xs font-medium transition-colors ${
                sortBy === "tokens"
                  ? "text-[var(--accent-blue)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              tokens {sortBy === "tokens" && "↓"}
            </button>
            <button
              onClick={() => setSortBy("cost")}
              className={`text-xs font-medium transition-colors ${
                sortBy === "cost"
                  ? "text-[var(--accent-blue)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              cost {sortBy === "cost" && "↓"}
            </button>
            <span className="text-xs text-[var(--text-muted)] opacity-40">msg</span>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {paginated.map((s) => (
          <div key={s.sessionId}>
            <button
              onClick={() => setExpanded(expanded === s.sessionId ? null : s.sessionId)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-[var(--text-muted)] font-mono whitespace-nowrap">
                    {formatDateTime(s.startTime)}
                  </span>
                  <span className="text-xs text-[var(--text-secondary)] truncate">
                    {shortProject(s.project)}
                  </span>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-xs font-mono text-[var(--accent-blue)]">
                    {formatTokens(s.totalTokens)}
                  </span>
                  <span className="text-xs font-mono text-[var(--accent-orange)]">
                    {formatCost(s.totalCost)}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {s.messageCount} msg
                  </span>
                </div>
              </div>
            </button>

            {expanded === s.sessionId && (() => {
              // Compute % of limit if derivedLimits available
              const hasLimits = derivedLimits && derivedLimits.outputLimit > 0;
              const outputPct = hasLimits
                ? (s.outputTokens / derivedLimits!.outputLimit) * 100
                : null;
              const ioPct = hasLimits
                ? ((s.inputTokens + s.outputTokens) / derivedLimits!.inputOutputLimit) * 100
                : null;
              const totalPct = hasLimits
                ? (s.totalTokens / derivedLimits!.totalLimit) * 100
                : null;
              const hasCalibration = !!derivedLimits;

              return (
                <div className="ml-4 mt-1 mb-3 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] animate-fade-in">
                  {/* Row 1: token values + percentages inline */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
                    <span>
                      <span className="text-[var(--text-muted)]">In:</span>{" "}
                      <span className="text-[var(--accent-blue)] tabular-nums">{formatTokens(s.inputTokens)}</span>
                    </span>
                    <span>
                      <span className="text-[var(--text-muted)]">Out:</span>{" "}
                      <span className="text-[var(--accent-green)] tabular-nums">{formatTokens(s.outputTokens)}</span>
                    </span>
                    <span>
                      <span className="text-[var(--text-muted)]">CW:</span>{" "}
                      <span className="text-[var(--accent-purple)] tabular-nums">{formatTokens(s.cacheCreationTokens)}</span>
                    </span>
                    <span>
                      <span className="text-[var(--text-muted)]">CR:</span>{" "}
                      <span className="text-[var(--accent-cyan)] tabular-nums">{formatTokens(s.cacheReadTokens)}</span>
                    </span>
                    {outputPct !== null && (
                      <>
                        <span className="text-[var(--text-muted)]">·</span>
                        <span className="tabular-nums">
                          Out <span className="text-[var(--accent-green)]">{outputPct.toFixed(1)}%</span>
                          {!hasCalibration && "*"}
                        </span>
                        <span className="tabular-nums">
                          In+Out <span className="text-[var(--accent-blue)]">{ioPct!.toFixed(1)}%</span>
                        </span>
                        <span className="tabular-nums">
                          Total <span className="text-[var(--accent-cyan)]">{totalPct!.toFixed(1)}%</span>
                        </span>
                        {!hasCalibration && (
                          <span className="text-[var(--text-muted)]">[est.]</span>
                        )}
                      </>
                    )}
                  </div>

                  {/* Row 2: session meta */}
                  <div className="flex items-center justify-between mt-1 text-[11px] text-[var(--text-muted)]">
                    <span>
                      {s.messageCount} msgs / {s.durationMinutes > 0 ? formatDuration(s.durationMinutes) : "—"}
                    </span>
                    <span className="tabular-nums">
                      {formatTokens(s.totalTokens)} total · {formatCost(s.totalCost)}
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>
        ))}
      </div>

      {!compact && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4 pt-3 border-t border-[var(--border-subtle)]">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="px-3 py-1 text-xs rounded bg-[var(--bg-secondary)] text-[var(--text-muted)] disabled:opacity-30"
          >
            Prev
          </button>
          <span className="text-xs text-[var(--text-muted)]">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1 text-xs rounded bg-[var(--bg-secondary)] text-[var(--text-muted)] disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
