import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { UsageEntry, TokenUsage } from "./types";
import { calculateCost } from "./pricing";

const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");
const CACHE_DIR = path.join(os.homedir(), ".claude-monitor-cache");
const CACHE_FILE = path.join(CACHE_DIR, "usage-cache.json");
const CACHE_META_FILE = path.join(CACHE_DIR, "cache-meta.json");

interface CacheMeta {
  files: Record<string, { mtime: number; size: number }>;
  lastFullScan: number;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
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

function extractProjectName(filePath: string): string {
  const normalizedClaude = CLAUDE_DIR.replace(/\\/g, "/");
  const normalizedFile = filePath.replace(/\\/g, "/");
  const relative = normalizedFile.startsWith(normalizedClaude)
    ? normalizedFile.slice(normalizedClaude.length + 1)
    : path.relative(CLAUDE_DIR, filePath);
  const parts = relative.split(/[/\\]/);
  if (parts.length > 0) {
    const slug = parts[0];
    const cleaned = slug
      .replace(/^[A-Z]---/, "")
      .replace(/---/g, "/")
      .replace(/--/g, "/");
    const segments = cleaned.split(/[-/]/).filter(Boolean);
    if (segments.length > 3) {
      return segments.slice(-3).join("/");
    }
    return segments.slice(-2).join("/");
  }
  return "unknown";
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

export function readAllUsageData(): UsageEntry[] {
  const startTime = Date.now();

  if (!fs.existsSync(CLAUDE_DIR)) return [];

  const allFiles = findJsonlFiles(CLAUDE_DIR);
  console.log(`[reader] Found ${allFiles.length} JSONL files (${Date.now() - startTime}ms)`);

  const cacheMeta = loadCacheMeta();
  const cachedFileMap = cacheMeta?.files || {};

  const newOrChanged: string[] = [];
  const currentFileMap: Record<string, { mtime: number; size: number }> = {};

  for (const file of allFiles) {
    try {
      const stat = fs.statSync(file);
      currentFileMap[file] = { mtime: stat.mtimeMs, size: stat.size };
      const cached = cachedFileMap[file];
      if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size) {
        newOrChanged.push(file);
      }
    } catch {
      // skip
    }
  }

  console.log(`[reader] ${allFiles.length - newOrChanged.length} cached, ${newOrChanged.length} new/changed`);

  // No changes — return cache
  if (newOrChanged.length === 0 && cacheMeta) {
    const cached = loadCachedEntries();
    if (cached.length > 0) {
      saveCacheMeta({ files: currentFileMap, lastFullScan: Date.now() });
      console.log(`[reader] Cache hit: ${cached.length} entries (${Date.now() - startTime}ms)`);
      return cached;
    }
  }

  const seen = new Set<string>();
  let entries: UsageEntry[];

  if (newOrChanged.length < allFiles.length * 0.3 && cacheMeta) {
    // Incremental: load cache, remove entries from changed files, process changed
    entries = loadCachedEntries();
    const changedSessionFiles = new Set(newOrChanged.map((f) => path.basename(f, ".jsonl")));
    for (const e of entries) {
      seen.add(`${e.sessionId}:${e.timestamp}`);
    }
    entries = entries.filter((e) => !changedSessionFiles.has(e.sessionId));

    for (const file of newOrChanged) {
      entries.push(...processFile(file, extractProjectName(file), seen));
    }
    console.log(`[reader] Incremental: processed ${newOrChanged.length} files`);
  } else {
    // Full rebuild
    entries = [];
    for (const file of allFiles) {
      entries.push(...processFile(file, extractProjectName(file), seen));
    }
    console.log(`[reader] Full rebuild: processed ${allFiles.length} files`);
  }

  entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  saveCachedEntries(entries);
  saveCacheMeta({ files: currentFileMap, lastFullScan: Date.now() });

  console.log(`[reader] Done: ${entries.length} entries in ${Date.now() - startTime}ms`);
  return entries;
}
