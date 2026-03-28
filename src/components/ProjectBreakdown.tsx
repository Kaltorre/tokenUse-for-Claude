"use client";

import { ProjectStats } from "@/lib/types";
import { formatTokens, formatCost, formatDate, shortProject } from "@/lib/format";

interface Props {
  projects: ProjectStats[];
  full?: boolean;
}

export function ProjectBreakdown({ projects, full }: Props) {
  const list = full ? projects : projects.slice(0, 10);
  const maxTokens = Math.max(...list.map((p) => p.totalTokens), 1);

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
        {full ? `All Projects (${projects.length})` : "Top Projects"}
      </h3>

      <div className="space-y-2">
        {list.map((p) => {
          const pct = (p.totalTokens / maxTokens) * 100;
          return (
            <div
              key={p.project}
              className="px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-xs text-[var(--text-primary)] truncate font-medium">
                  {full ? p.project : shortProject(p.project)}
                </span>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  <span className="font-mono text-[var(--accent-blue)]">
                    {formatTokens(p.totalTokens)}
                  </span>
                  <span className="font-mono text-[var(--accent-orange)]">
                    {formatCost(p.totalCost)}
                  </span>
                  <span className="text-[var(--text-muted)]">
                    {p.sessionCount} ses
                  </span>
                </div>
              </div>
              <div className="h-1 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-purple)] rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {full && (
                <div className="flex gap-4 mt-1 text-xs text-[var(--text-muted)]">
                  <span>{p.messageCount} messages</span>
                  <span>Last: {formatDate(p.lastUsed)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
