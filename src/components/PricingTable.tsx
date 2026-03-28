"use client";

import { PRICING_TABLE } from "@/lib/pricing";
import { ModelStats } from "@/lib/types";

interface Props {
  models?: ModelStats[];
}

const FAMILY_COLORS: Record<string, string> = {
  opus:   "#8b5cf6",
  sonnet: "#4f8ff7",
  haiku:  "#22c55e",
};

function fmt(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2).replace(/\.?0+$/, "")}`;
}

export function PricingTable({ models }: Props) {
  const usedModelKeys = new Set(
    (models ?? []).flatMap((m) => {
      const lower = m.model.toLowerCase();
      return PRICING_TABLE.filter((row) =>
        lower.includes(row.key.replace(/-/g, "[-_ ]?"))
      ).map((row) => row.key);
    })
  );

  const families = ["opus", "sonnet", "haiku"] as const;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Token Pricing</h2>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">
          Per 1M tokenów · USD · Claude Code używa cache 1h
        </p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border-subtle)]">
              <th className="text-left px-5 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Model
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Input
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Output
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Cache Write
                <span className="block text-[10px] normal-case tracking-normal opacity-70">1h (domyślny)</span>
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Cache Write
                <span className="block text-[10px] normal-case tracking-normal opacity-70">5min</span>
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Cache Read
              </th>
            </tr>
          </thead>
          <tbody>
            {families.map((family) => {
              const rows = PRICING_TABLE.filter((r) => r.family === family);
              const color = FAMILY_COLORS[family];
              return rows.map((row, i) => {
                const isUsed = usedModelKeys.has(row.key);
                return (
                  <tr
                    key={row.key}
                    className={`border-b border-[var(--border-subtle)] last:border-0 transition-colors ${
                      isUsed
                        ? "bg-[var(--accent-blue)]/5"
                        : "hover:bg-[var(--bg-secondary)]"
                    }`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        {i === 0 ? (
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: color }}
                          />
                        ) : (
                          <span className="w-2 h-2 shrink-0" />
                        )}
                        <span className={`font-medium ${isUsed ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
                          {row.label}
                        </span>
                        {isUsed && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-blue)]/15 text-[var(--accent-blue)] font-medium">
                            używany
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-[var(--accent-orange)]">
                      {fmt(row.pricing.input)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-[var(--accent-red)]">
                      {fmt(row.pricing.output)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-[var(--accent-purple)]">
                      {fmt(row.pricing.cache1hWrite)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-[var(--text-muted)]">
                      {fmt(row.pricing.cache5mWrite)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-[var(--accent-green)]">
                      {fmt(row.pricing.cacheRead)}
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>

      <div className="card p-4 text-xs text-[var(--text-muted)] space-y-1">
        <p>
          <span className="text-[var(--accent-blue)] font-medium">Cache Write 1h</span>
          {" "}— Claude Code domyślnie używa 1-godzinnego cache ({`2×`} cena inputu).
        </p>
        <p>
          <span className="text-[var(--accent-purple)] font-medium">Cache Write 5min</span>
          {" "}— krótszy TTL, tańszy ({`1.25×`} cena inputu).
        </p>
        <p>
          <span className="text-[var(--accent-green)] font-medium">Cache Read</span>
          {" "}— trafienie w cache ({`0.1×`} cena inputu). Duże oszczędności przy powtarzających się promptach.
        </p>
        <p className="pt-1 border-t border-[var(--border-subtle)]">
          Źródło: <span className="text-[var(--text-secondary)]">docs.anthropic.com/en/docs/about-claude/pricing</span>
          {" · "}zaktualizowano marzec 2026
        </p>
      </div>
    </div>
  );
}
