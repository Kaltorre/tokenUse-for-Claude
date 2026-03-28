"use client";

import { DailyStats } from "@/lib/types";
import { formatTokens } from "@/lib/format";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface Props {
  daily: DailyStats[];
}

export function DailyChart({ daily }: Props) {
  // Show last 30 days
  const data = daily.slice(-30).map((d) => ({
    date: d.date.slice(5), // MM-DD
    fullDate: d.date,
    input: d.inputTokens,
    output: d.outputTokens,
    cacheWrite: d.cacheCreationTokens,
    cacheRead: d.cacheReadTokens,
    total: d.totalTokens,
    sessions: d.sessionCount,
  }));

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
        Daily Token Usage (Last 30 days)
      </h3>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barSize={12}>
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
              tickFormatter={(v) => formatTokens(v)}
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={50}
            />
            <Tooltip
              contentStyle={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => [
                formatTokens(value),
                name === "input"
                  ? "Input"
                  : name === "output"
                  ? "Output"
                  : name === "cacheWrite"
                  ? "Cache Write"
                  : "Cache Read",
              ]}
              labelFormatter={(label) => `Date: ${label}`}
            />
            <Bar
              dataKey="cacheRead"
              stackId="a"
              fill="var(--accent-cyan)"
              radius={[0, 0, 0, 0]}
              opacity={0.7}
            />
            <Bar
              dataKey="cacheWrite"
              stackId="a"
              fill="var(--accent-purple)"
              radius={[0, 0, 0, 0]}
              opacity={0.8}
            />
            <Bar
              dataKey="input"
              stackId="a"
              fill="var(--accent-blue)"
              radius={[0, 0, 0, 0]}
            />
            <Bar
              dataKey="output"
              stackId="a"
              fill="var(--accent-green)"
              radius={[2, 2, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex gap-4 mt-3 justify-center text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-blue)]" />Input
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-green)]" />Output
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-purple)]" />Cache Write
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-cyan)]" />Cache Read
        </span>
      </div>
    </div>
  );
}
