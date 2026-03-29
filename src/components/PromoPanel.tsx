"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PromoPeriod, PromoSchedule } from "@/lib/types";
import {
  formatPolishDate,
  fromPolishDateInput,
  toPolishDateInput,
} from "@/lib/promo-time";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scheduleLabel(schedule: PromoSchedule): string {
  if (schedule.type === "all-day-all-week") return "All day, all week";
  if (schedule.type === "daily-hours") {
    return `Daily ${schedule.hourFrom}:00–${schedule.hourTo}:00`;
  }
  if (schedule.type === "weekdays") {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = schedule.days.map((d) => dayNames[d]).join(", ");
    if (schedule.hourFrom != null && schedule.hourTo != null) {
      const prefix = schedule.excludeHours ? "except" : "only";
      return `${days} ${prefix} ${schedule.hourFrom}:00–${schedule.hourTo}:00`;
    }
    return days;
  }
  return "Unknown";
}

// ─── Add/Edit Promo Dialog ────────────────────────────────────────────────────

type ScheduleType = "all-day-all-week" | "daily-hours" | "weekdays";
type PromoDraft = Omit<PromoPeriod, "id"> & { id?: string };

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface PromoDialogProps {
  initial?: PromoDraft;
  onSave: (period: PromoDraft) => Promise<void>;
  onClose: () => void;
}

function PromoDialog({ initial, onSave, onClose }: PromoDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [dateFrom, setDateFrom] = useState(initial ? toPolishDateInput(initial.dateFrom) : "");
  const [dateTo, setDateTo] = useState(initial ? toPolishDateInput(initial.dateTo) : "");
  const [scheduleType, setScheduleType] = useState<ScheduleType>(
    initial?.schedule.type ?? "all-day-all-week"
  );
  const [hourFrom, setHourFrom] = useState(
    initial?.schedule.type === "daily-hours" ? initial.schedule.hourFrom
    : initial?.schedule.type === "weekdays" ? (initial.schedule.hourFrom ?? 0)
    : 0
  );
  const [hourTo, setHourTo] = useState(
    initial?.schedule.type === "daily-hours" ? initial.schedule.hourTo
    : initial?.schedule.type === "weekdays" ? (initial.schedule.hourTo ?? 8)
    : 8
  );
  const [selectedDays, setSelectedDays] = useState<number[]>(
    initial?.schedule.type === "weekdays" ? initial.schedule.days : [1, 2, 3, 4, 5]
  );
  const [useHours, setUseHours] = useState(
    initial?.schedule.type === "weekdays"
      ? initial.schedule.hourFrom != null
      : false
  );
  const [excludeHours, setExcludeHours] = useState(
    initial?.schedule.type === "weekdays" ? (initial.schedule.excludeHours ?? false) : false
  );
  const [multiplier, setMultiplier] = useState(initial?.multiplier ?? 2);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const buildSchedule = (): PromoSchedule => {
    if (scheduleType === "all-day-all-week") return { type: "all-day-all-week" };
    if (scheduleType === "daily-hours") return { type: "daily-hours", hourFrom, hourTo };
    return {
      type: "weekdays",
      days: selectedDays,
      ...(useHours ? { hourFrom, hourTo, excludeHours } : {}),
    };
  };

  const validate = (): string | null => {
    if (!name.trim()) return "Name is required.";
    if (!dateFrom || !dateTo) return "Date range is required.";
    if (dateFrom > dateTo) return "Date from must be earlier than or equal to date to.";
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      return "Multiplier must be at least 1.";
    }

    const hasHours = scheduleType === "daily-hours" || (scheduleType === "weekdays" && useHours);
    if (scheduleType === "weekdays" && selectedDays.length === 0) {
      return "Select at least one day.";
    }

    if (hasHours) {
      if (!Number.isInteger(hourFrom) || hourFrom < 0 || hourFrom > 23) {
        return "Hour from must be between 0 and 23.";
      }
      if (!Number.isInteger(hourTo) || hourTo < 1 || hourTo > 24) {
        return "Hour to must be between 1 and 24.";
      }
      if (hourFrom >= hourTo) {
        return "Hour from must be earlier than hour to.";
      }
    }

    return null;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await onSave({
        id: initial?.id,
        name: name.trim(),
        dateFrom: fromPolishDateInput(dateFrom, "start"),
        dateTo: fromPolishDateInput(dateTo, "end"),
        schedule: buildSchedule(),
        multiplier,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save promo.");
    } finally {
      setSaving(false);
    }
  };

  const toggleDay = (day: number) => {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    );
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-black/50 py-8 px-4">
      <div
        className="card p-5 w-full max-w-md max-h-[calc(100vh-4rem)] overflow-y-auto"
        style={{ background: "var(--bg-card)" }}
      >
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
          {initial ? "Edit Promo Period" : "Add Promo Period"}
        </h3>

        <div className="space-y-4 mb-5">
          {/* Name */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Spring 2x Off-Peak"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
            />
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Date from</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                style={{ colorScheme: "dark" }}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Date to</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                style={{ colorScheme: "dark" }}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
              />
            </div>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] -mt-2">
            Dates are interpreted in Polish time.
          </p>

          {/* Schedule type */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-2">Schedule</label>
            <div className="space-y-1.5">
              {(["all-day-all-week", "daily-hours", "weekdays"] as ScheduleType[]).map((t) => (
                <label key={t} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="scheduleType"
                    checked={scheduleType === t}
                    onChange={() => setScheduleType(t)}
                    className="accent-[var(--accent-blue)]"
                  />
                  <span className="text-xs text-[var(--text-secondary)]">
                    {t === "all-day-all-week" ? "All day, all week"
                      : t === "daily-hours" ? "Daily hours"
                      : "Specific weekdays"}
                  </span>
                </label>
              ))}
            </div>

            {/* Daily hours fields */}
            {scheduleType === "daily-hours" && (
              <div className="mt-3">
              <p className="text-[10px] text-[var(--text-muted)] mb-2">Times in Polish time</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1">Hour from (0-23)</label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={hourFrom}
                    onChange={(e) => setHourFrom(parseInt(e.target.value) || 0)}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1">Hour to (0-23)</label>
                  <input
                    type="number"
                    min={0}
                    max={24}
                    value={hourTo}
                    onChange={(e) => setHourTo(parseInt(e.target.value) || 0)}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
                  />
                </div>
              </div>
              </div>
            )}

            {/* Weekdays fields */}
            {scheduleType === "weekdays" && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-2">Days</label>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAY_LABELS.map((label, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => toggleDay(idx)}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all border ${
                          selectedDays.includes(idx)
                            ? "border-[var(--accent-blue)] bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]"
                            : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-[var(--accent-blue)]/50"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useHours}
                    onChange={(e) => setUseHours(e.target.checked)}
                    className="accent-[var(--accent-blue)]"
                  />
                  <span className="text-xs text-[var(--text-secondary)]">Hours restriction</span>
                </label>

                {useHours && (
                  <div className="space-y-2">
                    <div className="flex gap-3">
                      {[false, true].map((isExclude) => (
                        <label key={String(isExclude)} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="excludeHours"
                            checked={excludeHours === isExclude}
                            onChange={() => setExcludeHours(isExclude)}
                            className="accent-[var(--accent-blue)]"
                          />
                          <span className="text-xs text-[var(--text-secondary)]">
                            {isExclude ? "Except (exclude peak)" : "Only during"}
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)]">Times in Polish time</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-[var(--text-muted)] mb-1">Hour from (0-23)</label>
                        <input
                          type="number"
                          min={0}
                          max={23}
                          value={hourFrom}
                          onChange={(e) => setHourFrom(parseInt(e.target.value) || 0)}
                          className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-[var(--text-muted)] mb-1">Hour to (0-23)</label>
                        <input
                          type="number"
                          min={0}
                          max={24}
                          value={hourTo}
                          onChange={(e) => setHourTo(parseInt(e.target.value) || 0)}
                          className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Multiplier */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Multiplier</label>
            <input
              type="number"
              min={1}
              max={10}
              step={0.1}
              value={multiplier}
              onChange={(e) => setMultiplier(parseFloat(e.target.value) || 1)}
              className="w-24 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
            />
            <span className="ml-2 text-xs text-[var(--text-muted)]">x limit during off-peak</span>
          </div>

          {error && (
            <div className="rounded-lg border border-[var(--accent-red)]/40 bg-[var(--accent-red)]/10 px-3 py-2 text-xs text-[var(--accent-red)]">
              {error}
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !dateFrom || !dateTo || saving}
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

// ─── Main PromoPanel Component ────────────────────────────────────────────────

interface PromoPanelProps {
  periods: PromoPeriod[];
  onPeriodsChange: () => void;
}

export function PromoPanel({ periods, onPeriodsChange }: PromoPanelProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState<PromoDraft | null>(null);

  const handleSave = async (data: PromoDraft) => {
    const response = await fetch("/api/promos", {
      method: data.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to save promo.");
    }

    await onPeriodsChange();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/promos?id=${id}`, { method: "DELETE" });
    onPeriodsChange();
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Promo Periods</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Configure promotional multiplier windows (e.g. 2x off-peak limits)
          </p>
        </div>
        <button
          onClick={() => { setEditingPeriod(null); setShowDialog(true); }}
          className="px-3 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent-orange)] text-white hover:opacity-90 transition-opacity"
        >
          + Add Promo
        </button>
      </div>

      {/* Table */}
      <div className="card p-5">
        {periods.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] text-sm">
            No promo periods configured.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-3 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <span>Name</span>
              <span>Period</span>
              <span>Schedule</span>
              <span className="text-center">Mult</span>
              <span></span>
            </div>

            {periods.map((p) => {
              const now = new Date();
              const from = new Date(p.dateFrom);
              const to = new Date(p.dateTo);
              const isActive = now >= from && now <= to;
              const isPast = now > to;

              return (
                <div
                  key={p.id}
                  className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-3 items-center px-3 py-2.5 rounded-lg border transition-colors"
                  style={{
                    borderColor: isActive
                      ? "color-mix(in srgb, var(--accent-orange) 50%, transparent)"
                      : "var(--border-subtle)",
                    background: isActive
                      ? "color-mix(in srgb, var(--accent-orange) 6%, transparent)"
                      : undefined,
                    opacity: isPast ? 0.6 : 1,
                  }}
                >
                  {/* Name */}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-[var(--text-primary)] truncate">{p.name}</span>
                    {isActive && (
                      <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-orange)]/20 text-[var(--accent-orange)] font-medium">
                        active
                      </span>
                    )}
                    {isPast && (
                      <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-[var(--text-muted)]/20 text-[var(--text-muted)] font-medium">
                        past
                      </span>
                    )}
                  </div>

                  {/* Date range */}
                  <div className="text-xs text-[var(--text-muted)] tabular-nums">
                    {formatPolishDate(p.dateFrom)} – {formatPolishDate(p.dateTo)}
                  </div>

                  {/* Schedule */}
                  <div className="text-xs text-[var(--text-secondary)]">
                    {scheduleLabel(p.schedule)}
                  </div>

                  {/* Multiplier chip */}
                  <div
                    className="text-xs font-bold px-2 py-1 rounded text-center tabular-nums"
                    style={{
                      background: "color-mix(in srgb, var(--accent-orange) 18%, transparent)",
                      color: "var(--accent-orange)",
                      minWidth: 36,
                    }}
                  >
                    {p.multiplier}x
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => { setEditingPeriod(p); setShowDialog(true); }}
                      className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        setEditingPeriod({
                          ...p,
                          id: undefined,
                          name: `${p.name} copy`,
                        });
                        setShowDialog(true);
                      }}
                      className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-orange)] hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                      Copy
                    </button>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                      Del
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Info note */}
      <div className="text-xs text-[var(--text-muted)] px-1 space-y-1">
        <p>
          Multiplier is the maximum (off-peak) value. The effective multiplier scales by peak status:
          peak = 1x, mixed = weighted avg, off-peak = full multiplier.
        </p>
        <p>
          When multiple promo periods overlap, the highest multiplier wins.
        </p>
      </div>

      {/* Dialog */}
      {showDialog && (
        <PromoDialog
          initial={editingPeriod ?? undefined}
          onSave={handleSave}
          onClose={() => { setShowDialog(false); setEditingPeriod(null); }}
        />
      )}
    </div>
  );
}
