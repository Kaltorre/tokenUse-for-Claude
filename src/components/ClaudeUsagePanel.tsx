"use client";

import { useCallback, useEffect, useState } from "react";

interface UsageData {
  fetchedAt: string;
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  sevenDaySonnet: { utilization: number; resetsAt: string } | null;
  extraUsage: { isEnabled: boolean; utilization: number | null } | null;
}

const BOOKMARKLET_CODE = `javascript:void(function(){var o=document.cookie.split(';').map(function(c){return c.trim()}).find(function(c){return c.startsWith('lastActiveOrg=')});if(!o){alert('Not on claude.ai or not logged in');return}var orgId=o.split('=')[1];fetch('/api/organizations/'+orgId+'/usage',{credentials:'include'}).then(function(r){return r.json()}).then(function(d){return fetch('http://localhost:3016/api/claude-usage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})}).then(function(r){return r.json()}).then(function(r){if(r.ok)alert('Usage sent to dashboard!');else alert('Error: '+JSON.stringify(r))}).catch(function(e){alert('Failed: '+e.message)})})()`;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function UtilBar({ pct, label, resetAt }: { pct: number; label: string; resetAt: string }) {
  const color =
    pct >= 80 ? "var(--accent-red)" : pct >= 50 ? "var(--accent-orange)" : "var(--accent-green)";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--text-secondary)]">{label}</span>
        <span className="tabular-nums" style={{ color }}>
          {pct}%
          <span className="text-[var(--text-muted)] ml-1.5">resets {timeUntil(resetAt)}</span>
        </span>
      </div>
      <div className="h-2 rounded-full bg-[var(--bg-secondary)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(pct, 100)}%`, background: color }}
        />
      </div>
    </div>
  );
}

export function ClaudeUsagePanel() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const fetchUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/claude-usage");
      const json = await res.json();
      setData(json.data ?? null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 30_000);
    return () => clearInterval(interval);
  }, [fetchUsage]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(BOOKMARKLET_CODE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select text
    }
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Claude.ai Usage</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Live usage % from claude.ai/settings/usage
          </p>
        </div>
        <button
          onClick={fetchUsage}
          className="px-3 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent-blue)] text-white hover:opacity-90 transition-opacity"
        >
          Refresh
        </button>
      </div>

      {/* Usage bars */}
      <div className="card p-5">
        {loading ? (
          <div className="text-center py-6 text-sm text-[var(--text-muted)]">Loading...</div>
        ) : !data ? (
          <div className="text-center py-6 text-sm text-[var(--text-muted)]">
            No usage data yet. Use the bookmarklet below to fetch data from claude.ai.
          </div>
        ) : (
          <div className="space-y-4">
            {data.fiveHour && (
              <UtilBar pct={data.fiveHour.utilization} label="5-hour session" resetAt={data.fiveHour.resetsAt} />
            )}
            {data.sevenDay && (
              <UtilBar pct={data.sevenDay.utilization} label="Weekly — all models" resetAt={data.sevenDay.resetsAt} />
            )}
            {data.sevenDaySonnet && (
              <UtilBar pct={data.sevenDaySonnet.utilization} label="Weekly — Sonnet only" resetAt={data.sevenDaySonnet.resetsAt} />
            )}
            {data.extraUsage?.isEnabled && data.extraUsage.utilization != null && (
              <div className="text-xs text-[var(--text-muted)]">
                Extra usage: {data.extraUsage.utilization}%
              </div>
            )}
            <div className="text-[10px] text-[var(--text-muted)] text-right">
              Fetched {timeAgo(data.fetchedAt)}
            </div>
          </div>
        )}
      </div>

      {/* Bookmarklet setup */}
      <div className="card p-4 space-y-3">
        <h3 className="text-xs font-medium text-[var(--text-secondary)]">Setup: Bookmarklet</h3>
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          Drag the link below to your bookmarks bar. Then visit{" "}
          <span className="text-[var(--text-secondary)]">claude.ai</span> and click it to send usage data here.
        </p>
        <div className="flex items-center gap-3">
          <a
            href={BOOKMARKLET_CODE}
            onClick={(e) => e.preventDefault()}
            className="inline-block px-3 py-1.5 text-[11px] font-medium rounded-lg border border-[var(--accent-blue)] text-[var(--accent-blue)] bg-[var(--accent-blue)]/10 cursor-grab select-none"
            draggable
          >
            Fetch Claude Usage
          </a>
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {copied ? "Copied!" : "Copy code"}
          </button>
        </div>
        <p className="text-[10px] text-[var(--text-muted)]">
          Alternative: open DevTools console on claude.ai and paste the copied code.
        </p>
      </div>
    </div>
  );
}
