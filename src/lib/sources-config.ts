import * as fs from "fs";
import * as path from "path";
import { DataSource, SourcesConfig } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const SOURCES_FILE = path.join(DATA_DIR, "sources.json");

export function loadSourcesConfig(): SourcesConfig {
  try {
    if (fs.existsSync(SOURCES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf-8"));
      return {
        primaryEnabled: raw.primaryEnabled !== false,
        sources: (raw.sources ?? []) as DataSource[],
      };
    }
  } catch {}

  return { primaryEnabled: true, sources: [] };
}

export function loadSources(): DataSource[] {
  return loadSourcesConfig().sources;
}

export function getSourcesHash(primaryEnabled: boolean, sources: DataSource[]): string {
  const parts = sources
    .filter((source) => source.enabled)
    .map((source) => `${source.path}|${source.label}`)
    .sort();

  return `primary:${primaryEnabled};${parts.join(";")}`;
}

