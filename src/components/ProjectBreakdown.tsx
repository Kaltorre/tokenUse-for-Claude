"use client";

import { Fragment, useState } from "react";
import { ProjectStats } from "@/lib/types";
import { formatTokens, formatCost, formatDate, shortProject } from "@/lib/format";

interface Props {
  projects: ProjectStats[];
  full?: boolean;
}

export function ProjectBreakdown({ projects, full }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = full ? projects : projects.slice(0, 10);

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
        {full ? `All Projects (${projects.length})` : "Top Projects"}
      </h3>

      {list.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No project data.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)]">
                <th className="text-left py-2 px-2 text-[var(--text-muted)] font-medium">Project</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Cost</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Tokens</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">In</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Out</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">CacheW</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">CacheR</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Msgs</th>
                <th className="text-right py-2 px-2 text-[var(--text-muted)] font-medium">Ses</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p, idx) => {
                const isExpanded = expanded === p.project;
                const modelEntries = Object.entries(p.models).sort(
                  ([, a], [, b]) => b.totalCost - a.totalCost
                );

                return (
                  <Fragment key={p.project}>
                    <tr
                      onClick={() =>
                        setExpanded(isExpanded ? null : p.project)
                      }
                      className={`border-b border-[var(--border-subtle)] cursor-pointer hover:bg-[var(--bg-secondary)] transition-colors ${
                        idx === 0 ? "bg-[var(--bg-secondary)]" : ""
                      }`}
                    >
                      <td className="py-2 px-2 text-[var(--text-secondary)] font-medium">
                        <span className="truncate block max-w-[220px]" title={p.project}>
                          {full ? p.project : shortProject(p.project)}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[var(--accent-green)]">
                        {formatCost(p.totalCost)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[var(--accent-blue)]">
                        {formatTokens(p.totalTokens)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                        {formatTokens(p.inputTokens)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                        {formatTokens(p.outputTokens)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                        {formatTokens(p.cacheCreationTokens)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                        {formatTokens(p.cacheReadTokens)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                        {p.messageCount}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[var(--text-muted)]">
                        {p.sessionCount}
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr key={`${p.project}-detail`}>
                        <td colSpan={9} className="p-0">
                          <div className="mx-2 my-1 px-3 py-2.5 rounded-lg bg-[var(--bg-secondary)] animate-fade-in">
                            {/* Project meta */}
                            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] mb-2.5">
                              <span>
                                {p.messageCount} msgs · {p.sessionCount} sessions · Total: {formatTokens(p.totalTokens)}
                              </span>
                              <span>Last: {formatDate(p.lastUsed)}</span>
                            </div>

                            {/* Per-model breakdown */}
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="border-b border-[var(--border-subtle)]">
                                  <th className="text-left py-1 px-2 text-[10px] text-[var(--text-muted)] font-medium opacity-60">model</th>
                                  <th className="text-right py-1 px-2 text-[10px] text-[var(--text-muted)] font-medium opacity-60">cost</th>
                                  <th className="text-right py-1 px-2 text-[10px] text-[var(--text-muted)] font-medium opacity-60">tokens</th>
                                  <th className="text-right py-1 px-2 text-[10px] text-[var(--text-muted)] font-medium opacity-60">in</th>
                                  <th className="text-right py-1 px-2 text-[10px] text-[var(--text-muted)] font-medium opacity-60">out</th>
                                  <th className="text-right py-1 px-2 text-[10px] text-[var(--text-muted)] font-medium opacity-60">cw</th>
                                  <th className="text-right py-1 px-2 text-[10px] text-[var(--text-muted)] font-medium opacity-60">cr</th>
                                  <th className="text-right py-1 px-2 text-[10px] text-[var(--text-muted)] font-medium opacity-60">msg</th>
                                </tr>
                              </thead>
                              <tbody>
                                {modelEntries.map(([model, m]) => (
                                  <tr key={model} className="hover:bg-[var(--bg-primary)] transition-colors">
                                    <td className="py-1 px-2 text-[var(--text-secondary)] font-medium truncate max-w-[180px]">
                                      {model}
                                    </td>
                                    <td className="py-1 px-2 text-right tabular-nums text-[var(--accent-green)]">
                                      {formatCost(m.totalCost)}
                                    </td>
                                    <td className="py-1 px-2 text-right tabular-nums text-[var(--accent-blue)]">
                                      {formatTokens(m.totalTokens)}
                                    </td>
                                    <td className="py-1 px-2 text-right tabular-nums text-[var(--text-muted)]">
                                      {formatTokens(m.inputTokens)}
                                    </td>
                                    <td className="py-1 px-2 text-right tabular-nums text-[var(--text-muted)]">
                                      {formatTokens(m.outputTokens)}
                                    </td>
                                    <td className="py-1 px-2 text-right tabular-nums text-[var(--text-muted)]">
                                      {formatTokens(m.cacheCreationTokens)}
                                    </td>
                                    <td className="py-1 px-2 text-right tabular-nums text-[var(--text-muted)]">
                                      {formatTokens(m.cacheReadTokens)}
                                    </td>
                                    <td className="py-1 px-2 text-right tabular-nums text-[var(--text-muted)]">
                                      {m.messageCount}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
