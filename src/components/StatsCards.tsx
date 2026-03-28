"use client";

import { OverviewStats } from "@/lib/types";
import { formatTokens, formatCost } from "@/lib/format";

interface Props {
  overview: OverviewStats;
}

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  color: string;
}

function StatCard({ label, value, sub, color }: StatCardProps) {
  return (
    <div className="card p-5">
      <p className="text-[var(--text-muted)] text-xs font-medium uppercase tracking-wider mb-2">
        {label}
      </p>
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
      {sub && (
        <p className="text-[var(--text-muted)] text-xs mt-1">{sub}</p>
      )}
    </div>
  );
}

export function StatsCards({ overview }: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <StatCard
        label="Today Tokens"
        value={formatTokens(overview.todayTokens)}
        sub={formatCost(overview.todayCost)}
        color="text-[var(--accent-blue)]"
      />
      <StatCard
        label="Today Sessions"
        value={overview.todaySessions.toString()}
        color="text-[var(--accent-purple)]"
      />
      <StatCard
        label="This Week"
        value={formatTokens(overview.thisWeekTokens)}
        sub={formatCost(overview.thisWeekCost)}
        color="text-[var(--accent-cyan)]"
      />
      <StatCard
        label="This Month"
        value={formatTokens(overview.thisMonthTokens)}
        sub={formatCost(overview.thisMonthCost)}
        color="text-[var(--accent-green)]"
      />
      <StatCard
        label="All Time"
        value={formatTokens(overview.totalTokens)}
        sub={`${formatCost(overview.totalCost)} total`}
        color="text-[var(--accent-orange)]"
      />
      <StatCard
        label="Total Sessions"
        value={overview.totalSessions.toString()}
        sub={`${overview.totalMessages} messages`}
        color="text-[var(--text-primary)]"
      />
    </div>
  );
}
