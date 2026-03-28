"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LimitsData, SessionOverrides, WeeklyBucket } from "@/lib/types";
import { weekKeyFromDate } from "@/lib/plans";

type WeeklyOverrideScope = "all" | "sonnet";

function formatWeekRange(start: string, end: string): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(local: string): string {
  return new Date(local).toISOString();
}

function getWeeklyOverrideStorageKey(
  scope: WeeklyOverrideScope,
  bucket: Pick<WeeklyBucket, "weekStart">
): string {
  return `${scope}:${bucket.weekStart}`;
}

function getWeeklyOverrideMatch(
  overrides: SessionOverrides,
  bucket: Pick<WeeklyBucket, "weekStart">,
  scope: WeeklyOverrideScope
): { key: string; entry: SessionOverrides["weekly"][string] } | null {
  const scopedKey = getWeeklyOverrideStorageKey(scope, bucket);
  if (overrides.weekly[scopedKey]) {
    return { key: scopedKey, entry: overrides.weekly[scopedKey] };
  }

  const legacyKey = weekKeyFromDate(bucket.weekStart);
  if (overrides.weekly[legacyKey]) {
    return { key: legacyKey, entry: overrides.weekly[legacyKey] };
  }

  return null;
}

interface EditDialogProps {
  overrideKey: string;
  initialStart: string;
  initialEnd: string;
  onSave: (start: string, end: string) => Promise<void>;
  onClose: () => void;
}

function EditBoundariesDialog({
  overrideKey,
  initialStart,
  initialEnd,
  onSave,
  onClose,
}: EditDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [start, setStart] = useState(toDatetimeLocal(initialStart));
  const [end, setEnd] = useState(toDatetimeLocal(initialEnd));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(fromDatetimeLocal(start), fromDatetimeLocal(end));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="card p-5 w-full max-w-sm mx-4">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
          Weekly Window Override
        </h3>
        <div className="text-[10px] text-[var(--text-muted)] mb-4">
          Key: <code className="font-mono">{overrideKey}</code>
        </div>

        <div className="space-y-3 mb-5">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Start</label>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">End</label>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
            />
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-xs font-medium bg-[var(--accent-blue)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface WeeklyWindowsConfigTabProps {
  limitsData: LimitsData;
}

export function WeeklyWindowsConfigTab({ limitsData }: WeeklyWindowsConfigTabProps) {
  const [overrides, setOverrides] = useState<SessionOverrides>({ weekly: {}, "5h": {} });
  const [editTarget, setEditTarget] = useState<{
    key: string;
    label: string;
    start: string;
    end: string;
  } | null>(null);

  const fetchOverrides = useCallback(async () => {
    try {
      const res = await fetch("/api/session-overrides", { cache: "no-store" });
      if (res.ok) {
        setOverrides(await res.json());
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchOverrides();
  }, [fetchOverrides]);

  const handleSaveOverride = async (key: string, start: string, end: string) => {
    await fetch("/api/session-overrides", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "weekly", key, start, end }),
    });
    await fetchOverrides();
  };

  const handleDeleteOverride = async (key: string) => {
    await fetch(`/api/session-overrides?type=weekly&key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    await fetchOverrides();
  };

  const rows = [
    ...limitsData.weeklyAll.map((bucket) => ({ scope: "all" as const, label: "ALL", bucket })),
    ...limitsData.weeklySonnet.map((bucket) => ({ scope: "sonnet" as const, label: "SNNT", bucket })),
  ].sort(
    (a, b) => new Date(b.bucket.weekStart).getTime() - new Date(a.bucket.weekStart).getTime()
  );

  return (
    <div className="space-y-4 animate-fade-in max-w-5xl">
      <div className="card p-5">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Weekly Window Config</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Auto-detected 7-day windows plus manual overrides stored in DB.
            </p>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] text-sm">
            No weekly buckets available.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map(({ scope, label, bucket }) => {
              const overrideMatch = getWeeklyOverrideMatch(overrides, bucket, scope);
              const effectiveStart = overrideMatch?.entry.start ?? bucket.weekStart;
              const effectiveEnd = overrideMatch?.entry.end ?? bucket.weekEnd;
              const storageKey = getWeeklyOverrideStorageKey(scope, bucket);
              const isCurrent = bucket.timeRemainingMs > 0;

              return (
                <div
                  key={`${scope}:${bucket.weekStart}`}
                  className="rounded-lg border border-[var(--border-subtle)] px-4 py-3 bg-[var(--bg-secondary)]/35"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                            scope === "all"
                              ? "bg-[var(--accent-purple)]/15 text-[var(--accent-purple)]"
                              : "bg-[var(--accent-cyan)]/15 text-[var(--accent-cyan)]"
                          }`}
                        >
                          {label}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {weekKeyFromDate(bucket.weekStart)}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-green)]/20 text-[var(--accent-green)]">
                            current
                          </span>
                        )}
                        {overrideMatch && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]">
                            override
                          </span>
                        )}
                      </div>

                      <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                        Auto: {formatWeekRange(bucket.weekStart, bucket.weekEnd)}
                      </div>
                      <div className="text-[11px] text-[var(--text-secondary)] tabular-nums">
                        Effective: {formatWeekRange(effectiveStart, effectiveEnd)}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] font-mono mt-1 break-all">
                        {overrideMatch?.key ?? storageKey}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() =>
                          setEditTarget({
                            key: storageKey,
                            label: `${label} ${weekKeyFromDate(bucket.weekStart)}`,
                            start: effectiveStart,
                            end: effectiveEnd,
                          })
                        }
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[var(--text-muted)] border border-[var(--border-subtle)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue)] transition-colors"
                      >
                        {overrideMatch ? "Edit override" : "Add override"}
                      </button>
                      {overrideMatch && (
                        <button
                          onClick={() => handleDeleteOverride(overrideMatch.key)}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-[var(--accent-red)] border border-[var(--accent-red)]/35 hover:bg-[var(--accent-red)]/10 transition-colors"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editTarget && (
        <EditBoundariesDialog
          overrideKey={editTarget.label}
          initialStart={editTarget.start}
          initialEnd={editTarget.end}
          onSave={(start, end) => handleSaveOverride(editTarget.key, start, end)}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}
