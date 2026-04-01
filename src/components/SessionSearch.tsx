"use client";

import { useCallback, useRef, useState } from "react";
import { formatDateTime, shortProject } from "@/lib/format";

interface SearchMatch {
  role: "user" | "assistant";
  text: string;
  matchStart: number;
  matchLength: number;
  timestamp: string;
}

interface SearchResult {
  sessionId: string;
  project: string;
  cwd: string;
  filePath: string;
  firstTimestamp: string;
  matches: SearchMatch[];
  totalMatches: number;
}

export function SessionSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [searchTime, setSearchTime] = useState<number | null>(null);
  const [days, setDays] = useState(30);
  const abortRef = useRef<AbortController | null>(null);

  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setSearchTime(null);
    const t0 = Date.now();

    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(q)}&limit=50&days=${days}`,
        { signal: controller.signal, cache: "no-store" }
      );
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      if (!controller.signal.aborted) {
        setResults(data);
        setSearched(true);
        setSearchTime(Date.now() - t0);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      console.error("Search error:", e);
      if (!controller.signal.aborted) {
        setResults([]);
        setSearched(true);
        setSearchTime(Date.now() - t0);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [query, days]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch();
    }
  };

  const handleClear = () => {
    setQuery("");
    setResults([]);
    setSearched(false);
    setSearchTime(null);
    abortRef.current?.abort();
    setLoading(false);
  };

  function renderSnippet(match: SearchMatch) {
    const { text, matchStart, matchLength } = match;
    const before = text.slice(0, matchStart);
    const highlighted = text.slice(matchStart, matchStart + matchLength);
    const after = text.slice(matchStart + matchLength);

    return (
      <span className="text-[11px] leading-relaxed">
        <span className="text-[var(--text-muted)]">{before}</span>
        <span className="bg-[var(--accent-orange)]/25 text-[var(--accent-orange)] font-medium rounded-sm px-0.5">
          {highlighted}
        </span>
        <span className="text-[var(--text-muted)]">{after}</span>
      </span>
    );
  }

  return (
    <div className="card p-5 mb-4">
      <div className="mb-3">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-2">
          Search Sessions
        </h3>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search by keywords in conversation text..."
              disabled={loading}
              className="w-full px-3 py-2 pl-8 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)] focus:ring-1 focus:ring-[var(--accent-blue)]/30 transition-colors disabled:opacity-60"
            />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] text-xs">
              /
            </span>
            {query && !loading && (
              <button
                onClick={handleClear}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-xs"
              >
                x
              </button>
            )}
          </div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={loading}
            className="px-2 py-2 text-xs rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent-blue)] disabled:opacity-60 shrink-0"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={0}>All time</option>
          </select>
          <button
            onClick={doSearch}
            disabled={loading || query.trim().length < 2}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-[var(--accent-blue)] text-white hover:bg-[var(--accent-blue)]/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 border border-white/60 border-t-transparent rounded-full animate-spin" />
                Searching...
              </span>
            ) : (
              "Search"
            )}
          </button>
        </div>
        {loading && (
          <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
            Scanning session files... This may take a moment for large histories.
          </p>
        )}
      </div>

      {searched && !loading && (
        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--border-subtle)] mb-1">
          <span className="text-xs text-[var(--text-muted)]">
            {results.length === 0
              ? `No sessions found for "${query.trim()}"`
              : `${results.length} session${results.length !== 1 ? "s" : ""} found`}
          </span>
          {searchTime !== null && (
            <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
              {(searchTime / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}

      {results.length > 0 && !loading && (
        <div className="space-y-1">
          {results.map((r) => (
            <div key={r.sessionId}>
              <button
                onClick={() => setExpanded(expanded === r.sessionId ? null : r.sessionId)}
                className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-[var(--bg-secondary)] transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xs text-[var(--text-muted)] font-mono whitespace-nowrap">
                      {r.firstTimestamp ? formatDateTime(r.firstTimestamp) : "—"}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)] truncate">
                      {shortProject(r.project)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] text-[var(--accent-orange)] tabular-nums">
                      {r.totalMatches} match{r.totalMatches !== 1 ? "es" : ""}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {expanded === r.sessionId ? "−" : "+"}
                    </span>
                  </div>
                </div>

                {/* Preview: first match snippet */}
                {expanded !== r.sessionId && r.matches[0] && (
                  <div className="mt-1 truncate">
                    {renderSnippet(r.matches[0])}
                  </div>
                )}
              </button>

              {expanded === r.sessionId && (
                <div className="ml-4 mt-1 mb-3 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] animate-fade-in space-y-2">
                  {/* Session info */}
                  <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
                    <span className="font-mono">{r.sessionId.slice(0, 8)}...</span>
                    {r.cwd && (
                      <span className="truncate" title={r.cwd}>
                        {r.cwd}
                      </span>
                    )}
                  </div>

                  {/* All match snippets */}
                  {r.matches.map((m, i) => (
                    <div key={i} className="border-l-2 border-[var(--border-subtle)] pl-2 py-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span
                          className={`text-[9px] font-medium uppercase tracking-wider ${
                            m.role === "user"
                              ? "text-[var(--accent-blue)]"
                              : "text-[var(--accent-green)]"
                          }`}
                        >
                          {m.role}
                        </span>
                        {m.timestamp && (
                          <span className="text-[9px] text-[var(--text-muted)] font-mono">
                            {formatDateTime(m.timestamp)}
                          </span>
                        )}
                      </div>
                      <div>{renderSnippet(m)}</div>
                    </div>
                  ))}

                  {r.totalMatches > r.matches.length && (
                    <p className="text-[10px] text-[var(--text-muted)]">
                      +{r.totalMatches - r.matches.length} more match{r.totalMatches - r.matches.length !== 1 ? "es" : ""} in this session
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
