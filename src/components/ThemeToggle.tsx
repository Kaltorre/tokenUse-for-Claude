"use client";

import { useEffect, useState } from "react";

export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme") as "dark" | "light" | null;
    if (stored) {
      setTheme(stored);
      document.documentElement.classList.toggle("light", stored === "light");
    }
    setMounted(true);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
    document.documentElement.classList.toggle("light", next === "light");
  };

  return { theme, toggleTheme, mounted };
}

export function ThemeToggle({
  theme,
  onToggle,
  compact = false,
}: {
  theme: "dark" | "light";
  onToggle: () => void;
  compact?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-medium transition-all text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]`}
      title={theme === "dark" ? "Przełącz na jasny motyw" : "Przełącz na ciemny motyw"}
    >
      <span className="w-5 text-center font-mono opacity-60">
        {theme === "dark" ? "◐" : "◑"}
      </span>
      {!compact && <span>{theme === "dark" ? "Jasny" : "Ciemny"}</span>}
    </button>
  );
}
