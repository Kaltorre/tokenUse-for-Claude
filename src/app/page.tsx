"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  UsageData,
  DerivedLimits,
  CalibrationPoint,
  CalibrationScope,
  SolvedLimits,
} from "@/lib/types";
import { loadDerivedLimits } from "@/lib/utilization";
import { solveLimits, detectAnomalies } from "@/lib/calibration";
import { StatsCards } from "@/components/StatsCards";
import { DailyChart } from "@/components/DailyChart";
import { SessionList } from "@/components/SessionList";
import { ProjectBreakdown } from "@/components/ProjectBreakdown";
import { ModelBreakdown } from "@/components/ModelBreakdown";
import { HourlyChart } from "@/components/HourlyChart";
import { CostChart } from "@/components/CostChart";
import { LimitsTab } from "@/components/LimitsTab";
import { CalibrationPanel } from "@/components/CalibrationPanel";
import { PricingTable } from "@/components/PricingTable";
import { PlanTab } from "@/components/PlanTab";
import { PromoPanel } from "@/components/PromoPanel";
import { WeeklyWindowsConfigTab } from "@/components/WeeklyWindowsConfigTab";
import { WeeklyAggregationTab } from "@/components/WeeklyAggregationTab";
import { CalibrationDeltaTable } from "@/components/CalibrationDeltaTable";
import { PlanPeriod, PromoPeriod } from "@/lib/types";
import { useTheme, ThemeToggle } from "@/components/ThemeToggle";
import { SourcesPanel } from "@/components/SourcesPanel";

type Tab = "overview" | "sessions" | "projects" | "limits" | "weeklyAgg" | "deltaAnalysis" | "weeklyWindows" | "calibration" | "plan" | "promos" | "sources" | "pricing";

type NavItem = { key: Tab; label: string; icon: string; indent?: boolean };
type NavSection = { section: string; items: NavItem[] };
type NavEntry = NavItem | NavSection;

function isNavSection(entry: NavEntry): entry is NavSection {
  return "section" in entry;
}

const NAV_ENTRIES: NavEntry[] = [
  { key: "overview", label: "Overview", icon: "~" },
  { key: "sessions", label: "Sessions", icon: "#" },
  { key: "projects", label: "Projects", icon: ">" },
  { key: "limits", label: "Limits", icon: "%" },
  { key: "weeklyAgg", label: "Usage Agg", icon: "Σ" },
  { key: "deltaAnalysis", label: "Δ Analysis", icon: "Δ" },
  {
    section: "⚙ Config",
    items: [
      { key: "plan", label: "Plans", icon: "◈", indent: true },
      { key: "weeklyWindows", label: "Windows", icon: "▣", indent: true },
      { key: "promos", label: "Promos", icon: "✦", indent: true },
      { key: "calibration", label: "Calibration", icon: "⊕", indent: true },
      { key: "sources", label: "Sources", icon: "⊞", indent: true },
    ],
  },
  { key: "pricing", label: "Pricing", icon: "$" },
];

function buildSolvedLimits(
  calibrations: CalibrationPoint[]
): Record<CalibrationScope, SolvedLimits> {
  return {
    "5h": solveLimits(calibrations, "5h"),
    "weekly-all": solveLimits(calibrations, "weekly-all"),
    "weekly-sonnet": solveLimits(calibrations, "weekly-sonnet"),
  };
}

export default function Home() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [derivedLimits, setDerivedLimits] = useState<DerivedLimits | null>(
    null
  );
  const [calibrations, setCalibrations] = useState<CalibrationPoint[]>([]);
  const [planPeriods, setPlanPeriods] = useState<PlanPeriod[]>([]);
  const [promoPeriods, setPromoPeriods] = useState<PromoPeriod[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const planPeriodsRef = useRef<PlanPeriod[]>([]);
  const { theme, toggleTheme } = useTheme();

  // Load derived limits from localStorage
  useEffect(() => {
    setDerivedLimits(loadDerivedLimits());
  }, []);

  useEffect(() => {
    planPeriodsRef.current = planPeriods;
  }, [planPeriods]);

  // Load calibrations from server
  const fetchCalibrations = useCallback(async () => {
    try {
      const res = await fetch("/api/calibrations");
      if (res.ok) {
        const points = await res.json() as CalibrationPoint[];
        setCalibrations(detectAnomalies(points, planPeriodsRef.current));
      }
    } catch (e) {
      console.error("Failed to load calibrations:", e);
    }
  }, []);

  const fetchPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/plans");
      if (res.ok) {
        const config = await res.json();
        setPlanPeriods(config.periods ?? []);
      }
    } catch (e) {
      console.error("Failed to load plans:", e);
    }
  }, []);

  const fetchPromos = useCallback(async () => {
    try {
      const res = await fetch("/api/promos");
      if (res.ok) {
        const config = await res.json();
        setPromoPeriods(config.periods ?? []);
      }
    } catch (e) {
      console.error("Failed to load promos:", e);
    }
  }, []);

  // Promos can change how snapshots are interpreted; keep anomaly labels aligned
  // with the latest plan-aware baseline after promo config updates.
  const handlePromoChange = useCallback(async () => {
    await fetchPromos();
    setCalibrations((prev) => detectAnomalies(prev, planPeriodsRef.current));
  }, [fetchPromos]);

  useEffect(() => {
    fetchCalibrations();
    fetchPlans();
    fetchPromos();
  }, [fetchCalibrations, fetchPlans, fetchPromos]);

  useEffect(() => {
    if (calibrations.length === 0) return;
    setCalibrations((prev) => detectAnomalies(prev, planPeriods));
  }, [planPeriods, calibrations.length]);

  // Solve limits whenever calibrations change
  const solvedLimits = useMemo(
    () => buildSolvedLimits(calibrations),
    [calibrations]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      try {
        const r = await fetch("/api/usage", { cache: "no-store" });
        if (!r.ok) throw new Error("Failed to load data");
        const json = await r.json();
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load data");
          setLoading(false);
        }
      }
    }
    loadData();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight mb-6">
            <span className="text-[var(--accent-blue)]">tocken</span>
            <span className="text-[var(--accent-purple)]">Usage</span>
            <span className="text-[var(--text-muted)]">C</span>
          </h1>
          <div className="w-8 h-8 border-2 border-[var(--accent-blue)] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-[var(--text-muted)]">Loading usage data...</p>
          <p className="text-[10px] text-[var(--text-muted)] mt-1">First load may take a moment</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="card p-8 text-center max-w-md">
          <p className="text-[var(--accent-red)] text-lg mb-2">Error</p>
          <p className="text-[var(--text-secondary)]">
            {error || "No data available"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? "w-52" : "w-14"
        } shrink-0 bg-[var(--bg-card)] border-r border-[var(--border-subtle)] flex flex-col transition-all duration-200 sticky top-0 h-screen`}
      >
        {/* Logo */}
        <div className="p-4 border-b border-[var(--border-subtle)]">
          {sidebarOpen ? (
            <h1 className="text-lg font-semibold tracking-tight">
              <span className="text-[var(--accent-blue)]">tocken</span>
              <span className="text-[var(--accent-purple)]">Usage</span>
              <span className="text-[var(--text-muted)]">C</span>
            </h1>
          ) : (
            <h1 className="text-lg font-semibold text-center">
              <span className="text-[var(--accent-blue)]">t</span>
              <span className="text-[var(--accent-purple)]">U</span>
            </h1>
          )}
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-2">
          {NAV_ENTRIES.map((entry, idx) => {
            if (isNavSection(entry)) {
              return (
                <div key={`section-${idx}`}>
                  {sidebarOpen && (
                    <div className="text-[var(--text-muted)] uppercase text-[9px] tracking-widest px-4 py-1 mt-2 select-none">
                      {entry.section}
                    </div>
                  )}
                  {entry.items.map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setTab(item.key)}
                      className={`w-full flex items-center gap-3 py-2 text-sm font-medium transition-all ${
                        sidebarOpen ? "px-6" : "px-4"
                      } ${
                        tab === item.key
                          ? "bg-[var(--accent-blue)]/10 text-[var(--accent-blue)] border-r-2 border-[var(--accent-blue)]"
                          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                      }`}
                    >
                      <span className="w-5 text-center text-xs font-mono opacity-60">
                        {item.icon}
                      </span>
                      {sidebarOpen && <span>{item.label}</span>}
                    </button>
                  ))}
                </div>
              );
            }
            return (
              <button
                key={entry.key}
                onClick={() => setTab(entry.key)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium transition-all ${
                  tab === entry.key
                    ? "bg-[var(--accent-blue)]/10 text-[var(--accent-blue)] border-r-2 border-[var(--accent-blue)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                }`}
              >
                <span className="w-5 text-center text-xs font-mono opacity-60">
                  {entry.icon}
                </span>
                {sidebarOpen && <span>{entry.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Bottom actions */}
        <div className="p-3 border-t border-[var(--border-subtle)] space-y-2">
          {/* Open data folder */}
          <button
            onClick={() => fetch("/api/open-data-folder", { method: "POST" })}
            title="Open .claude/projects"
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] hover:bg-[var(--bg-secondary)] transition-all"
          >
            <span className="w-5 text-center font-mono opacity-60">📂</span>
            {sidebarOpen && <span>.claude/projects</span>}
          </button>

          {/* Theme toggle */}
          <ThemeToggle theme={theme} onToggle={toggleTheme} compact={!sidebarOpen} />

          {/* Collapse toggle */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition-all"
          >
            <span className="w-5 text-center font-mono opacity-60">
              {sidebarOpen ? "<" : ">"}
            </span>
            {sidebarOpen && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 p-4 md:p-6 lg:p-8 max-w-[1400px]">
        {/* Overview Tab */}
        {tab === "overview" && (
          <div className="space-y-6 animate-fade-in">
            <StatsCards overview={data.overview} />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <DailyChart daily={data.daily} />
              <CostChart daily={data.daily} />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <ModelBreakdown models={data.models} />
              <HourlyChart hourly={data.hourly} />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <ProjectBreakdown projects={data.projects} />
              <SessionList sessions={data.sessions.slice(0, 15)} compact derivedLimits={derivedLimits} />
            </div>
          </div>
        )}

        {/* Sessions Tab */}
        {tab === "sessions" && (
          <div className="animate-fade-in">
            <SessionList sessions={data.sessions} derivedLimits={derivedLimits} />
          </div>
        )}

        {/* Projects Tab */}
        {tab === "projects" && (
          <div className="animate-fade-in">
            <ProjectBreakdown projects={data.projects} full />
          </div>
        )}

        {/* Limits Tab */}
        {tab === "limits" && (
          <LimitsTab
            limitsData={data.limits}
            solvedLimits={solvedLimits}
            derivedLimits={derivedLimits}
            calibrations={calibrations}
            planPeriods={planPeriods}
            promoPeriods={promoPeriods}
          />
        )}

        {/* Weekly Aggregation Tab */}
        {tab === "weeklyAgg" && (
          <WeeklyAggregationTab
            weeklyAll={data.limits.weeklyAll}
            weeklySonnet={data.limits.weeklySonnet}
            windows={data.limits.windows}
            derivedLimits={derivedLimits}
            solvedLimits={solvedLimits}
            planPeriods={planPeriods}
            promoPeriods={promoPeriods}
          />
        )}

        {/* Delta Analysis Tab */}
        {tab === "deltaAnalysis" && (
          <div className="animate-fade-in">
            <CalibrationDeltaTable calibrations={calibrations} />
          </div>
        )}

        {/* Calibration Tab */}
        {tab === "calibration" && (
          <div className="animate-fade-in max-w-4xl">
            <CalibrationPanel
              currentWindow={data.limits.currentWindow}
              currentWeekAll={data.limits.currentWeekAll}
              currentWeekSonnet={data.limits.currentWeekSonnet}
              calibrations={calibrations}
              solvedLimits={solvedLimits}
              onCalibrationChange={fetchCalibrations}
              planPeriods={planPeriods}
            />
          </div>
        )}

        {/* Plan Tab */}
        {tab === "plan" && (
          <div className="animate-fade-in max-w-4xl">
            <PlanTab
              periods={planPeriods}
              solvedLimits={solvedLimits}
              limitsData={data.limits}
              onPeriodsChange={fetchPlans}
              promoPeriods={promoPeriods}
              calibrations={calibrations}
            />
          </div>
        )}

        {/* Weekly Windows Config Tab */}
        {tab === "weeklyWindows" && (
          <WeeklyWindowsConfigTab limitsData={data.limits} />
        )}

        {/* Promos Tab */}
        {tab === "promos" && (
          <div className="animate-fade-in max-w-4xl">
            <PromoPanel periods={promoPeriods} onPeriodsChange={handlePromoChange} />
          </div>
        )}

        {/* Sources Tab */}
        {tab === "sources" && (
          <div className="animate-fade-in max-w-4xl">
            <SourcesPanel />
          </div>
        )}

        {/* Pricing Tab */}
        {tab === "pricing" && (
          <div className="max-w-3xl animate-fade-in">
            <PricingTable models={data.models} />
          </div>
        )}
      </main>
    </div>
  );
}
