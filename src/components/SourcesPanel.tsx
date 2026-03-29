"use client";

import { useEffect, useState, useCallback } from "react";
import { DataSource } from "@/lib/types";

// ─── Add/Edit Source Dialog ──────────────────────────────────────────────────

interface SourceDialogProps {
  initial?: DataSource;
  onSave: (data: Partial<DataSource> & { path: string; label: string }) => Promise<void>;
  onClose: () => void;
}

function SourceDialog({ initial, onSave, onClose }: SourceDialogProps) {
  const [pathValue, setPathValue] = useState(initial?.path ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!pathValue.trim()) {
      setError("Path is required.");
      return;
    }
    if (!label.trim()) {
      setError("Label is required.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await onSave({
        id: initial?.id,
        path: pathValue.trim(),
        label: label.trim(),
        enabled: initial?.enabled !== false,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save source.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-5 border-2 border-[var(--accent-blue)]/30">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-4">
        {initial ? "Edit Source" : "Add Data Source"}
      </h3>

      <div className="space-y-4 mb-5">
        {/* Label */}
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Laptop, PC Work, Backup"
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
          />
        </div>

        {/* Path */}
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Path to .claude/projects directory</label>
          <input
            type="text"
            value={pathValue}
            onChange={(e) => setPathValue(e.target.value)}
            placeholder="e.g. H:\backups\laptop\.claude\projects"
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
          />
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Point to the .claude/projects folder (or any folder containing .jsonl session files).
          </p>
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
          disabled={!pathValue.trim() || !label.trim() || saving}
          className="px-4 py-2 text-xs font-medium bg-[var(--accent-blue)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

// ─── Main SourcesPanel Component ─────────────────────────────────────────────

export function SourcesPanel() {
  const [sources, setSources] = useState<DataSource[]>([]);
  const [primaryEnabled, setPrimaryEnabled] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingSource, setEditingSource] = useState<DataSource | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch("/api/sources");
      if (res.ok) {
        const config = await res.json();
        setSources(config.sources ?? []);
        setPrimaryEnabled(config.primaryEnabled !== false);
      }
    } catch (e) {
      console.error("Failed to load sources:", e);
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  const handleSave = async (data: Partial<DataSource> & { path: string; label: string }) => {
    const response = await fetch("/api/sources", {
      method: data.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to save source.");
    }

    await fetchSources();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/sources?id=${id}`, { method: "DELETE" });
    await fetchSources();
  };

  const handleToggle = async (source: DataSource) => {
    await fetch("/api/sources", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...source, enabled: !source.enabled }),
    });
    await fetchSources();
  };

  const handleTogglePrimary = async () => {
    await fetch("/api/sources", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primaryEnabled: !primaryEnabled }),
    });
    await fetchSources();
  };

  const openFolder = (folderPath?: string) => {
    fetch("/api/open-data-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath ?? "" }),
    });
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Data Sources</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Add additional session directories (backups, other computers)
          </p>
        </div>
        <button
          onClick={() => {
            setEditingSource(null);
            setShowDialog(true);
          }}
          className="px-3 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent-blue)] text-white hover:opacity-90 transition-opacity"
        >
          + Add Source
        </button>
      </div>

      {/* Primary source */}
      <div className="card p-4" style={{ opacity: primaryEnabled ? 1 : 0.5 }}>
        <div className="flex items-center gap-3">
          <button
            onClick={handleTogglePrimary}
            className={`w-8 h-4 rounded-full relative transition-colors shrink-0 ${
              primaryEnabled ? "bg-[var(--accent-blue)]" : "bg-[var(--bg-secondary)] border border-[var(--border-subtle)]"
            }`}
            title={primaryEnabled ? "Disable primary source" : "Enable primary source"}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
                primaryEnabled ? "left-4" : "left-0.5"
              }`}
            />
          </button>
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-[var(--text-primary)]">Local (default)</span>
            <p className="text-xs text-[var(--text-muted)] font-mono truncate mt-0.5">
              ~/.claude/projects
            </p>
          </div>
          <button
            onClick={() => openFolder()}
            className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-secondary)] transition-colors shrink-0"
            title="Open folder"
          >
            Open
          </button>
          <span
            className={`text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
              primaryEnabled
                ? "bg-[var(--accent-green)]/20 text-[var(--accent-green)]"
                : "bg-[var(--text-muted)]/20 text-[var(--text-muted)]"
            }`}
          >
            {primaryEnabled ? "on" : "off"}
          </span>
        </div>
      </div>

      {/* Additional sources */}
      {sources.length > 0 && (
        <div className="card p-5">
          <div className="space-y-2">
            <div className="grid grid-cols-[auto_1fr_2fr_auto_auto] gap-3 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              <span></span>
              <span>Label</span>
              <span>Path</span>
              <span className="text-center">Status</span>
              <span></span>
            </div>

            {sources.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[auto_1fr_2fr_auto_auto] gap-3 items-center px-3 py-2.5 rounded-lg border transition-colors"
                style={{
                  borderColor: s.enabled
                    ? "color-mix(in srgb, var(--accent-blue) 30%, transparent)"
                    : "var(--border-subtle)",
                  opacity: s.enabled ? 1 : 0.5,
                }}
              >
                {/* Toggle */}
                <button
                  onClick={() => handleToggle(s)}
                  className={`w-8 h-4 rounded-full relative transition-colors ${
                    s.enabled ? "bg-[var(--accent-blue)]" : "bg-[var(--bg-secondary)] border border-[var(--border-subtle)]"
                  }`}
                  title={s.enabled ? "Disable" : "Enable"}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
                      s.enabled ? "left-4" : "left-0.5"
                    }`}
                  />
                </button>

                {/* Label */}
                <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                  {s.label}
                </span>

                {/* Path */}
                <span className="text-xs text-[var(--text-muted)] font-mono truncate" title={s.path}>
                  {s.path}
                </span>

                {/* Status */}
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                    s.enabled
                      ? "bg-[var(--accent-green)]/20 text-[var(--accent-green)]"
                      : "bg-[var(--text-muted)]/20 text-[var(--text-muted)]"
                  }`}
                >
                  {s.enabled ? "on" : "off"}
                </span>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => openFolder(s.path)}
                    className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-secondary)] transition-colors"
                    title="Open folder"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => {
                      setEditingSource(s);
                      setShowDialog(true);
                    }}
                    className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-secondary)] transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-secondary)] transition-colors"
                  >
                    Del
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add/Edit dialog (inline) */}
      {showDialog && (
        <SourceDialog
          initial={editingSource ?? undefined}
          onSave={handleSave}
          onClose={() => {
            setShowDialog(false);
            setEditingSource(null);
          }}
        />
      )}

      {/* Info note */}
      <div className="text-xs text-[var(--text-muted)] px-1 space-y-1">
        <p>
          Toggle any source on/off, including the default local source.
          Projects from additional sources are prefixed with [Label] in the dashboard.
        </p>
        <p>
          Use this to aggregate sessions from backups or other computers. Reload the page after changing sources.
        </p>
      </div>
    </div>
  );
}
