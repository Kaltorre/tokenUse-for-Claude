"use client";

import { ModelStats } from "@/lib/types";
import { formatTokens, formatCost } from "@/lib/format";

interface Props {
  models: ModelStats[];
}

const MODEL_COLORS: Record<string, string> = {
  "Opus": "#8b5cf6",
  "Sonnet": "#4f8ff7",
  "Haiku": "#22c55e",
};

function getModelColor(name: string): string {
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (name.includes(key)) return color;
  }
  return "#9090a8";
}

export function ModelBreakdown({ models }: Props) {
  const totalCost = models.reduce((sum, m) => sum + m.totalCost, 0);
  const totalTokensAll = models.reduce((sum, m) => sum + m.totalTokens, 0);

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
        Model Usage
      </h3>

      {/* Visual breakdown bar */}
      <div className="h-3 bg-[var(--bg-secondary)] rounded-full overflow-hidden flex mb-4">
        {models.map((m) => {
          const pct = totalTokensAll > 0 ? (m.totalTokens / totalTokensAll) * 100 : 0;
          if (pct < 0.5) return null;
          return (
            <div
              key={m.model}
              className="h-full transition-all"
              style={{
                width: `${pct}%`,
                backgroundColor: getModelColor(m.model),
              }}
              title={`${m.model}: ${pct.toFixed(1)}%`}
            />
          );
        })}
      </div>

      <div className="space-y-3">
        {models.map((m) => {
          const costPct = totalCost > 0 ? (m.totalCost / totalCost) * 100 : 0;
          const tokenPct = totalTokensAll > 0 ? (m.totalTokens / totalTokensAll) * 100 : 0;
          const color = getModelColor(m.model);

          return (
            <div
              key={m.model}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-sm font-medium text-[var(--text-primary)] min-w-[100px]">
                {m.model}
              </span>
              <div className="flex-1 grid grid-cols-4 gap-2 text-xs text-right">
                <span className="text-[var(--text-muted)]">
                  {tokenPct.toFixed(1)}%
                </span>
                <span className="font-mono text-[var(--accent-blue)]">
                  {formatTokens(m.totalTokens)}
                </span>
                <span className="font-mono text-[var(--accent-orange)]">
                  {formatCost(m.totalCost)}
                </span>
                <span className="text-[var(--text-muted)]">
                  {costPct.toFixed(1)}% cost
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
