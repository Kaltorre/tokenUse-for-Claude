"use client";

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
  hourly: { hour: number; tokens: number; cost: number; messages: number }[];
}

export function HourlyChart({ hourly }: Props) {
  const data = hourly.map((h) => ({
    hour: `${h.hour.toString().padStart(2, "0")}:00`,
    tokens: h.tokens,
    messages: h.messages,
  }));

  return (
    <div className="card p-5">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
        Activity by Hour of Day
      </h3>
      <div className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barSize={14}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border-subtle)"
              vertical={false}
            />
            <XAxis
              dataKey="hour"
              tick={{ fill: "var(--text-muted)", fontSize: 9 }}
              axisLine={{ stroke: "var(--border-subtle)" }}
              tickLine={false}
              interval={2}
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
                name === "tokens" ? formatTokens(value) : value,
                name === "tokens" ? "Tokens" : "Messages",
              ]}
            />
            <Bar
              dataKey="tokens"
              fill="var(--accent-cyan)"
              radius={[3, 3, 0, 0]}
              opacity={0.85}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
