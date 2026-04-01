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

      {/* Table header */}
      {!compact && (
        <div className="grid grid-cols-[auto_1fr_repeat(5,auto)] gap-x-3 items-center px-3 pb-1.5 border-b border-[var(--border-subtle)] mb-1">
          <button
            onClick={() => setSortBy("time")}
            className={`text-xs font-medium transition-colors whitespace-nowrap ${
              sortBy === "time"
                ? "text-[var(--accent-blue)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            time {sortBy === "time" && "↓"}
          </button>
          <span className="text-xs text-[var(--text-muted)] opacity-40">project</span>
          <span className="text-xs text-[var(--text-muted)] opacity-40 text-right">In</span>
          <span className="text-xs text-[var(--text-muted)] opacity-40 text-right">Out</span>
          <button
            onClick={() => setSortBy("tokens")}
            className={`text-xs font-medium transition-colors text-right ${
              sortBy === "tokens"
                ? "text-[var(--accent-blue)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            total {sortBy === "tokens" && "↓"}
          </button>
          <button
            onClick={() => setSortBy("cost")}
            className={`text-xs font-medium transition-colors text-right ${
              sortBy === "cost"
                ? "text-[var(--accent-blue)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            cost {sortBy === "cost" && "↓"}
          </button>
          <span className="text-xs text-[var(--text-muted)] opacity-40 text-right">msg</span>
        </div>
      )}

      <div className="space-y-0.5">
        {paginated.map((s) => (
          <div key={s.sessionId}>
            <button
              onClick={() => setExpanded(expanded === s.sessionId ? null : s.sessionId)}
              className="w-full text-left px-3 py-2 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
            >
              {compact ? (
                /* Compact mode: original layout */
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
              ) : (
                /* Full mode: grid table row */
                <div className="grid grid-cols-[auto_1fr_repeat(5,auto)] gap-x-3 items-center">
                  <span className="text-xs text-[var(--text-muted)] font-mono whitespace-nowrap">
                    {formatDateTime(s.startTime)}
                  </span>
                  <span className="text-xs text-[var(--text-secondary)] truncate">
                    {shortProject(s.project)}
                  </span>
                  <span className="text-xs font-mono text-[var(--accent-blue)] text-right tabular-nums">
                    {formatTokens(s.inputTokens)}
                  </span>
                  <span className="text-xs font-mono text-[var(--accent-green)] text-right tabular-nums">
                    {formatTokens(s.outputTokens)}
                  </span>
                  <span className="text-xs font-mono text-[var(--accent-cyan)] text-right tabular-nums">
                    {formatTokens(s.totalTokens)}
                  </span>
                  <span className="text-xs font-mono text-[var(--accent-orange)] text-right tabular-nums">
                    {formatCost(s.totalCost)}
                  </span>
                  <span className="text-xs text-[var(--text-muted)] text-right tabular-nums">
                    {s.messageCount}
                  </span>
                </div>
              )}
            </button>

            {expanded === s.sessionId && (
              <ExpandedSession s={s} derivedLimits={derivedLimits} />
            )}
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

function ExpandedSession({
  s,
  derivedLimits,
}: {
  s: SessionStats;
  derivedLimits?: DerivedLimits | null;
}) {
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
  const costPct = hasLimits
    ? (s.totalCost / derivedLimits!.costLimit) * 100
    : null;

  const modelEntries = Object.entries(s.models).sort(([, a], [, b]) => b - a);

  return (
    <div className="ml-4 mt-1 mb-3 px-3 py-3 rounded-lg bg-[var(--bg-secondary)] animate-fade-in space-y-3">
      {/* Token breakdown with percentages */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-muted)]">Input</span>
          <span className="text-[11px] font-mono text-[var(--accent-blue)] tabular-nums">
            {formatTokens(s.inputTokens)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-muted)]">Output</span>
          <span className="text-[11px] font-mono text-[var(--accent-green)] tabular-nums">
            {formatTokens(s.outputTokens)}
            {outputPct !== null && (
              <span className="text-[var(--text-muted)] ml-1">({outputPct.toFixed(1)}%)</span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-muted)]">Cache Write</span>
          <span className="text-[11px] font-mono text-[var(--accent-purple)] tabular-nums">
            {formatTokens(s.cacheCreationTokens)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-muted)]">Cache Read</span>
          <span className="text-[11px] font-mono text-[var(--accent-cyan)] tabular-nums">
            {formatTokens(s.cacheReadTokens)}
          </span>
        </div>
      </div>

      {/* Limit percentages */}
      {outputPct !== null && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px]">
          <span className="tabular-nums text-[var(--text-muted)]">
            Out <span className="text-[var(--accent-green)]">{outputPct.toFixed(1)}%</span>
          </span>
          <span className="tabular-nums text-[var(--text-muted)]">
            In+Out <span className="text-[var(--accent-blue)]">{ioPct!.toFixed(1)}%</span>
          </span>
          <span className="tabular-nums text-[var(--text-muted)]">
            Total <span className="text-[var(--accent-cyan)]">{totalPct!.toFixed(1)}%</span>
          </span>
          <span className="tabular-nums text-[var(--text-muted)]">
            Cost <span className="text-[var(--accent-orange)]">{costPct!.toFixed(1)}%</span>
          </span>
        </div>
      )}

      {/* Model breakdown */}
      {modelEntries.length > 0 && (
        <div>
          <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Models</span>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
            {modelEntries.map(([model, count]) => {
              const short = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
              return (
                <span key={model} className="text-[11px] tabular-nums">
                  <span className="text-[var(--text-secondary)]">{short}</span>
                  <span className="text-[var(--text-muted)] ml-1">x{count}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Session meta */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px] text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
        <span>{s.messageCount} msgs</span>
        <span>{s.durationMinutes > 0 ? formatDuration(s.durationMinutes) : "—"}</span>
        <span className="tabular-nums">
          {formatTokens(s.totalTokens)} total · {formatCost(s.totalCost)}
        </span>
        <span className="font-mono opacity-60" title={s.sessionId}>
          {s.sessionId.slice(0, 8)}...
        </span>
        <span className="truncate opacity-60" title={s.cwd}>
          {s.cwd}
        </span>
      </div>
    </div>
  );
}
