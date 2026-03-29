import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { UsageEntry, TokenUsage, DataSource, SourcesConfig } from "./types";
import { calculateCost } from "./pricing";

const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");
const CACHE_DIR = path.join(os.homedir(), ".claude-monitor-cache");
const CACHE_FILE = path.join(CACHE_DIR, "usage-cache.json");
const CACHE_META_FILE = path.join(CACHE_DIR, "cache-meta.json");

const DATA_DIR = path.join(process.cwd(), "data");
const SOURCES_FILE = path.join(DATA_DIR, "sources.json");

interface CacheMeta {
  files: Record<string, { mtime: number; size: number }>;
  lastFullScan: number;
  sourcesHash?: string;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

export function loadSourcesConfig(): SourcesConfig {
  try {
    if (fs.existsSync(SOURCES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf-8"));
      return { primaryEnabled: raw.primaryEnabled !== false, sources: (raw.sources ?? []) as DataSource[] };
    }
  } catch {}
  return { primaryEnabled: true, sources: [] };
}

export function loadSources(): DataSource[] {
  return loadSourcesConfig().sources;
}

function getSourcesHash(primaryEnabled: boolean, sources: DataSource[]): string {
  const parts = sources
    .filter((s) => s.enabled)
    .map((s) => `${s.path}|${s.label}`)
    .sort();
  return `primary:${primaryEnabled};${parts.join(";")}`;
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  const dirs = [dir];

  while (dirs.length > 0) {
    const currentDir = dirs.pop()!;
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          dirs.push(fullPath);
        } else if (entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      // skip inaccessible directories
    }
  }

  return files;
}

function extractProjectName(filePath: string, baseDir: string, sourceLabel?: string): string {
  const normalizedBase = baseDir.replace(/\\/g, "/");
  const normalizedFile = filePath.replace(/\\/g, "/");
  const relative = normalizedFile.startsWith(normalizedBase)
    ? normalizedFile.slice(normalizedBase.length + 1)
    : path.relative(baseDir, filePath);
  const parts = relative.split(/[/\\]/);
  if (parts.length > 0) {
    const slug = parts[0];
    const cleaned = slug
      .replace(/^[A-Z]---/, "")
      .replace(/---/g, "/")
      .replace(/--/g, "/");
    const segments = cleaned.split(/[-/]/).filter(Boolean);
    let project: string;
    if (segments.length > 3) {
      project = segments.slice(-3).join("/");
    } else {
      project = segments.slice(-2).join("/");
    }
    return sourceLabel ? `[${sourceLabel}] ${project}` : project;
  }
  return sourceLabel ? `[${sourceLabel}] unknown` : "unknown";
}

function parseUsage(data: Record<string, unknown>): TokenUsage | null {
  let usage: Record<string, unknown> | null = null;

  const message = data.message as Record<string, unknown> | undefined;
  if (message && typeof message === "object" && message.usage) {
    usage = message.usage as Record<string, unknown>;
  } else if (data.usage) {
    usage = data.usage as Record<string, unknown>;
  }

  if (!usage) return null;

  const inputTokens = (usage.input_tokens as number) || 0;
  const outputTokens = (usage.output_tokens as number) || 0;
  const cacheCreation = (usage.cache_creation_input_tokens as number) || 0;
  const cacheRead = (usage.cache_read_input_tokens as number) || 0;

  if (inputTokens === 0 && outputTokens === 0 && cacheCreation === 0 && cacheRead === 0) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

function getModel(data: Record<string, unknown>): string {
  const message = data.message as Record<string, unknown> | undefined;
  if (message && typeof message === "object") {
    return (message.model as string) || "";
  }
  return (data.model as string) || "";
}

function readAgentType(jsonlFile: string): string | undefined {
  // Look for matching .meta.json: agent-XXXX.jsonl → agent-XXXX.meta.json
  const metaFile = jsonlFile.replace(/\.jsonl$/, ".meta.json");
  try {
    if (fs.existsSync(metaFile)) {
      const data = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
      return data.agentType || undefined;
    }
  } catch {}
  return undefined;
}

function processFile(file: string, project: string, seen: Set<string>): UsageEntry[] {
  const entries: UsageEntry[] = [];
  try {
    const agentType = readAgentType(file);
    const content = fs.readFileSync(file, { encoding: "utf-8" });
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;

      try {
        const data = JSON.parse(line) as Record<string, unknown>;
        if (data.type !== "assistant") continue;

        const usage = parseUsage(data);
        if (!usage) continue;

        const model = getModel(data);
        const timestamp = data.timestamp as string;
        const sessionId = (data.sessionId as string) || "";
        const requestId = (data.requestId as string) || "";
        const cwd = (data.cwd as string) || "";

        const dedupKey = `${data.uuid || ""}:${requestId}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        entries.push({
          timestamp,
          sessionId,
          model,
          usage,
          cost: calculateCost(model, usage),
          project,
          cwd,
          type: "assistant",
          ...(agentType ? { agentType } : {}),
        });
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip unreadable files
  }
  return entries;
}

function loadCacheMeta(): CacheMeta | null {
  try {
    if (fs.existsSync(CACHE_META_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_META_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveCacheMeta(meta: CacheMeta) {
  ensureCacheDir();
  fs.writeFileSync(CACHE_META_FILE, JSON.stringify(meta));
}

function loadCachedEntries(): UsageEntry[] {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveCachedEntries(entries: UsageEntry[]) {
  ensureCacheDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(entries));
}

interface SourceDir {
  dir: string;
  label?: string;
}

function getSourceDirs(): { dirs: SourceDir[]; primaryEnabled: boolean; sources: DataSource[] } {
  const sf = loadSourcesConfig();
  const dirs: SourceDir[] = [];
  if (sf.primaryEnabled) {
    dirs.push({ dir: CLAUDE_DIR });
  }
  for (const src of sf.sources) {
    if (src.enabled && src.path && fs.existsSync(src.path)) {
      dirs.push({ dir: src.path, label: src.label });
    }
  }
  return { dirs, primaryEnabled: sf.primaryEnabled, sources: sf.sources };
}

export type ProgressStep = "init" | "scan" | "check" | "process" | "sort" | "save" | "analyze" | "done";
export type ProgressCallback = (step: ProgressStep, message: string, current?: number, total?: number) => void;

export function readAllUsageData(onProgress?: ProgressCallback): UsageEntry[] {
  const startTime = Date.now();
  const progress = onProgress ?? (() => {});

  progress("scan", "Scanning data sources...");

  const { dirs: sourceDirs, primaryEnabled, sources } = getSourceDirs();
  const currentSourcesHash = getSourcesHash(primaryEnabled, sources);

  progress("scan", `Scanning ${sourceDirs.length} source(s) for JSONL files...`);

  // Collect all JSONL files from all sources, tracking which source each comes from
  const allFiles: string[] = [];
  const fileSourceMap = new Map<string, SourceDir>();

  for (const src of sourceDirs) {
    if (!fs.existsSync(src.dir)) continue;
    const files = findJsonlFiles(src.dir);
    for (const file of files) {
      allFiles.push(file);
      fileSourceMap.set(file, src);
    }
  }

  console.log(
    `[reader] Found ${allFiles.length} JSONL files across ${sourceDirs.length} source(s) (${Date.now() - startTime}ms)`
  );
  progress("scan", `Found ${allFiles.length} JSONL files`, allFiles.length, allFiles.length);

  const cacheMeta = loadCacheMeta();
  const cachedFileMap = cacheMeta?.files || {};

  // Invalidate cache if sources config changed
  const sourcesChanged = cacheMeta?.sourcesHash !== currentSourcesHash;

  const newOrChanged: string[] = [];
  const currentFileMap: Record<string, { mtime: number; size: number }> = {};

  progress("check", "Checking file changes...");

  for (const file of allFiles) {
    try {
      const stat = fs.statSync(file);
      currentFileMap[file] = { mtime: stat.mtimeMs, size: stat.size };
      if (sourcesChanged) {
        newOrChanged.push(file);
      } else {
        const cached = cachedFileMap[file];
        if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size) {
          newOrChanged.push(file);
        }
      }
    } catch {
      // skip
    }
  }

  console.log(`[reader] ${allFiles.length - newOrChanged.length} cached, ${newOrChanged.length} new/changed`);
  progress("check", `${allFiles.length - newOrChanged.length} cached, ${newOrChanged.length} to process`, newOrChanged.length, allFiles.length);

  // No changes — return cache
  if (newOrChanged.length === 0 && cacheMeta && !sourcesChanged) {
    const cached = loadCachedEntries();
    if (cached.length > 0) {
      saveCacheMeta({ files: currentFileMap, lastFullScan: Date.now(), sourcesHash: currentSourcesHash });
      console.log(`[reader] Cache hit: ${cached.length} entries (${Date.now() - startTime}ms)`);
      progress("done", `Loaded ${cached.length} entries from cache`, cached.length, cached.length);
      return cached;
    }
  }

  const seen = new Set<string>();
  let entries: UsageEntry[];

  if (!sourcesChanged && newOrChanged.length < allFiles.length * 0.3 && cacheMeta) {
    // Incremental: load cache, remove entries from changed files, process changed
    progress("process", `Incremental update: processing ${newOrChanged.length} files...`, 0, newOrChanged.length);
    entries = loadCachedEntries();
    const changedSessionFiles = new Set(newOrChanged.map((f) => path.basename(f, ".jsonl")));
    for (const e of entries) {
      seen.add(`${e.sessionId}:${e.timestamp}`);
    }
    entries = entries.filter((e) => !changedSessionFiles.has(e.sessionId));

    for (let i = 0; i < newOrChanged.length; i++) {
      const file = newOrChanged[i];
      const src = fileSourceMap.get(file)!;
      entries.push(...processFile(file, extractProjectName(file, src.dir, src.label), seen));
      if (i % 5 === 0 || i === newOrChanged.length - 1) {
        progress("process", `Processing file ${i + 1}/${newOrChanged.length}`, i + 1, newOrChanged.length);
      }
    }
    console.log(`[reader] Incremental: processed ${newOrChanged.length} files`);
  } else {
    // Full rebuild
    progress("process", `Full rebuild: processing ${allFiles.length} files...`, 0, allFiles.length);
    entries = [];
    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      const src = fileSourceMap.get(file)!;
      entries.push(...processFile(file, extractProjectName(file, src.dir, src.label), seen));
      if (i % 5 === 0 || i === allFiles.length - 1) {
        progress("process", `Processing file ${i + 1}/${allFiles.length}`, i + 1, allFiles.length);
      }
    }
    console.log(`[reader] Full rebuild: processed ${allFiles.length} files`);
  }

  progress("sort", `Sorting ${entries.length} entries...`);
  entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  progress("save", "Saving cache...");
  saveCachedEntries(entries);
  saveCacheMeta({ files: currentFileMap, lastFullScan: Date.now(), sourcesHash: currentSourcesHash });

  console.log(`[reader] Done: ${entries.length} entries in ${Date.now() - startTime}ms`);
  progress("done", `Done: ${entries.length} entries in ${Date.now() - startTime}ms`, entries.length, entries.length);
  return entries;
}
