"use client";

import { DailyStats } from "@/lib/types";
import { formatCost } from "@/lib/format";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface Props {
  daily: DailyStats[];
}

export function CostChart({ daily }: Props) {
  const data = daily.slice(-30).map((d) => ({
    date: d.date.slice(5),
    cost: Number(d.totalCost.toFixed(4)),
    sessions: d.sessionCount,
    messages: d.messageCount,
  }));

  // Calculate cumulative for the period
  let cumulative = 0;
  const cumulativeData = data.map((d) => {
    cumulative += d.cost;
    return { ...d, cumulative: Number(cumulative.toFixed(2)) };
  });

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
        Daily Cost (Last 30 days)
      </h3>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={cumulativeData}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border-subtle)"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              axisLine={{ stroke: "var(--border-subtle)" }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v) => formatCost(v)}
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={55}
            />
            <Tooltip
              contentStyle={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => [
                formatCost(value),
                name === "cost" ? "Daily Cost" : "Cumulative",
              ]}
            />
            <Area
              type="monotone"
              dataKey="cumulative"
              stroke="var(--accent-purple)"
              fill="var(--accent-purple)"
              fillOpacity={0.1}
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="cost"
              stroke="var(--accent-orange)"
              fill="var(--accent-orange)"
              fillOpacity={0.15}
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex gap-4 mt-3 justify-center text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-orange)]" />Daily
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-purple)]" />Cumulative
        </span>
      </div>
    </div>
  );
}
