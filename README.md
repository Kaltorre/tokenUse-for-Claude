# tokenUse for Claude

A local dashboard for tracking and analyzing your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) token usage, costs, and rate limits.

Reads directly from Claude Code's local JSONL logs (`~/.claude/projects/`) — no API keys needed, everything stays on your machine.

## Features

- **Usage overview** — daily/hourly charts, cost breakdown, model & project stats
- **Session explorer** — per-session token breakdown, model mix, agent-type analysis
- **5-hour window tracking** — maps to Claude's rolling rate-limit windows
- **Weekly aggregation** — usage buckets aligned to weekly reset schedules
- **Limit calibration** — enter the % shown by Claude, the app reverse-engineers your actual token limits using multiple estimation methods (direct, cost-based, weighted, ensemble)
- **Anomaly detection** — flags calibration outliers (data-entry errors, unknown promos, genuine limit changes)
- **Promo period config** — define off-peak/bonus periods (2x capacity windows) with flexible schedules
- **Plan tier tracking** — Max $200, Max $100, Pro, Team, Free — with relative capacity multipliers
- **Pricing reference** — up-to-date per-model pricing table (Opus, Sonnet, Haiku across versions)
- **Dark/light theme**

## Tech stack

Next.js 15 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS 4 · Recharts

## Quick start

```bash
git clone https://github.com/Kaltorre/tokenUse-for-Claude.git
cd tokenUse-for-Claude
pnpm install
pnpm dev
```

Opens at [http://localhost:3016](http://localhost:3016).

### Windows shortcut

Run `_dev.bat` — kills any stale process on port 3016, installs deps, opens browser, starts dev server.

## How it works

1. **Reader** (`src/lib/reader.ts`) scans `~/.claude/projects/` for `.jsonl` session logs and `.meta.json` files
2. **Analyzer** (`src/lib/analyzer.ts`) aggregates entries into daily, session, project, model, and hourly stats
3. **Limits analyzer** (`src/lib/limits-analyzer.ts`) groups usage into 5-hour rolling windows and weekly buckets
4. **Calibration engine** (`src/lib/calibration.ts`) solves for actual limits from user-reported percentages using multiple methods
5. **API routes** serve the data; the React dashboard renders it

## Data

All data stays local. The `data/` directory (gitignored) stores your personal calibration points, plan config, and promo schedules. Nothing is sent anywhere.

### Importing calibration screenshots

`scripts/import-screenshots.py` — a helper to batch-import calibration data points from screenshots you've taken of Claude's usage %.

## License

MIT
