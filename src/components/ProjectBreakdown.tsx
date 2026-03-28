"use client";

import { useState } from "react";
import { ProjectStats } from "@/lib/types";
import { formatTokens, formatCost, formatDate, shortProject } from "@/lib/format";

interface Props {
  projects: ProjectStats[];
  full?: boolean;
}

export function ProjectBreakdown({ projects, full }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = full ? projects : projects.slice(0, 10);
  const maxTokens = Math.max(...list.map((p) => p.totalTokens), 1);

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
        {full ? `All Projects (${projects.length})` : "Top Projects"}
      </h3>

      {/* Column headers */}
      <div className="flex items-center justify-between px-3 pb-1.5 border-b border-[var(--border-subtle)] mb-1">
        <span className="text-xs text-[var(--text-muted)] opacity-60">project</span>
        <div className="flex items-center gap-3 shrink-0 text-[10px] text-[var(--text-muted)] opacity-60">
          <span className="w-[52px] text-right">input</span>
          <span className="w-[52px] text-right">output</span>
          <span className="w-[52px] text-right">cw</span>
          <span className="w-[52px] text-right">cr</span>
          <span className="w-[56px] text-right">cost</span>
          <span className="w-[36px] text-right">ses</span>
        </div>
      </div>

      <div className="space-y-0.5">
        {list.map((p) => {
          const pct = (p.totalTokens / maxTokens) * 100;
          const isExpanded = expanded === p.project;
          const modelEntries = Object.entries(p.models).sort(
            ([, a], [, b]) => b.totalCost - a.totalCost
          );

          return (
            <div key={p.project}>
              <button
                onClick={() =>
                  setExpanded(isExpanded ? null : p.project)
                }
                className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="text-xs text-[var(--text-primary)] truncate font-medium">
                    {full ? p.project : shortProject(p.project)}
                  </span>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    <span className="w-[52px] text-right font-mono text-[var(--accent-blue)]">
                      {formatTokens(p.inputTokens)}
                    </span>
                    <span className="w-[52px] text-right font-mono text-[var(--accent-green)]">
                      {formatTokens(p.outputTokens)}
                    </span>
                    <span className="w-[52px] text-right font-mono text-[var(--accent-purple)]">
                      {formatTokens(p.cacheCreationTokens)}
                    </span>
                    <span className="w-[52px] text-right font-mono text-[var(--accent-cyan)]">
                      {formatTokens(p.cacheReadTokens)}
                    </span>
                    <span className="w-[56px] text-right font-mono text-[var(--accent-orange)]">
                      {formatCost(p.totalCost)}
                    </span>
                    <span className="w-[36px] text-right text-[var(--text-muted)]">
                      {p.sessionCount}
                    </span>
                  </div>
                </div>
                <div className="h-1 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-purple)] rounded-full transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {full && !isExpanded && (
                  <div className="flex gap-4 mt-1 text-xs text-[var(--text-muted)]">
                    <span>{p.messageCount} messages</span>
                    <span>Last: {formatDate(p.lastUsed)}</span>
                  </div>
                )}
              </button>

              {isExpanded && (
                <div className="ml-4 mt-1 mb-3 px-3 py-2.5 rounded-lg bg-[var(--bg-secondary)] animate-fade-in">
                  {/* Project meta */}
                  <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] mb-2.5">
                    <span>
                      {p.messageCount} msgs · {p.sessionCount} sessions · Total: {formatTokens(p.totalTokens)}
                    </span>
                    <span>Last: {formatDate(p.lastUsed)}</span>
                  </div>

                  {/* Per-model breakdown header */}
                  <div className="flex items-center justify-between px-2 pb-1 border-b border-[var(--border-subtle)] mb-1">
                    <span className="text-[10px] text-[var(--text-muted)] opacity-60">model</span>
                    <div className="flex items-center gap-2 shrink-0 text-[10px] text-[var(--text-muted)] opacity-60">
                      <span className="w-[48px] text-right">input</span>
                      <span className="w-[48px] text-right">output</span>
                      <span className="w-[48px] text-right">cw</span>
                      <span className="w-[48px] text-right">cr</span>
                      <span className="w-[52px] text-right">cost</span>
                      <span className="w-[32px] text-right">msg</span>
                    </div>
                  </div>

                  {/* Per-model rows */}
                  <div className="space-y-0.5">
                    {modelEntries.map(([model, m]) => {
                      const modelPct = p.totalTokens > 0 ? (m.totalTokens / p.totalTokens) * 100 : 0;
                      return (
                        <div key={model} className="px-2 py-1.5 rounded hover:bg-[var(--bg-primary)] transition-colors">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[11px] text-[var(--text-secondary)] font-medium truncate">
                              {model}
                            </span>
                            <div className="flex items-center gap-2 shrink-0 text-[11px]">
                              <span className="w-[48px] text-right font-mono text-[var(--accent-blue)]">
                                {formatTokens(m.inputTokens)}
                              </span>
                              <span className="w-[48px] text-right font-mono text-[var(--accent-green)]">
                                {formatTokens(m.outputTokens)}
                              </span>
                              <span className="w-[48px] text-right font-mono text-[var(--accent-purple)]">
                                {formatTokens(m.cacheCreationTokens)}
                              </span>
                              <span className="w-[48px] text-right font-mono text-[var(--accent-cyan)]">
                                {formatTokens(m.cacheReadTokens)}
                              </span>
                              <span className="w-[52px] text-right font-mono text-[var(--accent-orange)]">
                                {formatCost(m.totalCost)}
                              </span>
                              <span className="w-[32px] text-right text-[var(--text-muted)]">
                                {m.messageCount}
                              </span>
                            </div>
                          </div>
                          <div className="h-0.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-[var(--accent-green)] to-[var(--accent-cyan)] rounded-full"
                              style={{ width: `${modelPct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
