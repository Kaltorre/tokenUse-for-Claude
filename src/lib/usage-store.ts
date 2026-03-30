import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { DataSource, TokenUsage, UsageEntry } from "./types";
import { calculateCost } from "./pricing";
import { getSourcesHash, loadSourcesConfig } from "./sources-config";

const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");
const CACHE_DIR = path.join(os.homedir(), ".claude-monitor-cache");
const DB_FILE = path.join(CACHE_DIR, "usage-store.sqlite");
const STORE_RECONCILE_MS = 60_000;
const FULL_RECONCILE_MS = 3 * 60_000;

export type ProgressStep =
  | "init"
  | "scan"
  | "check"
  | "process"
  | "sort"
  | "save"
  | "analyze"
  | "done";

export type ProgressCallback = (
  step: ProgressStep,
  message: string,
  current?: number,
  total?: number
) => void;

export interface UsageStoreMeta {
  revision: number;
  entriesCount: number;
  fileCount: number;
  sourcesHash: string;
  updatedAt: number;
  dbPath: string;
}

export interface UsageStoreSyncResult {
  meta: UsageStoreMeta;
  changed: boolean;
  scannedFiles: number;
  processedFiles: number;
}

interface SourceDir {
  dir: string;
  label?: string;
}

interface FileRecord {
  path: string;
  sourceDir: string;
  sourceLabel: string | null;
  project: string;
  observedSize: number;
  lastOffset: number;
  mtimeMs: number;
  metaSize: number;
  metaMtimeMs: number;
}

interface ScannedFile extends FileRecord {}

interface ParsedUsageEntry {
  eventKey: string;
  timestamp: string;
  sessionId: string;
  model: string;
  usage: TokenUsage;
  cost: number;
  project: string;
  cwd: string;
  type: string;
  agentType: string | null;
}

interface UsageStoreWatchState {
  key: string;
  watchers: fs.FSWatcher[];
  dirty: boolean;
  lastEventAt: number;
  ignoreUntil: number;
  changedPaths: Set<string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __usageStoreDb: DatabaseSync | undefined;
  // eslint-disable-next-line no-var
  var __usageStoreLastSync: { at: number; result: UsageStoreSyncResult } | undefined;
  // eslint-disable-next-line no-var
  var __usageStoreLastFullSync: number | undefined;
  // eslint-disable-next-line no-var
  var __usageStoreWatchState: UsageStoreWatchState | undefined;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function watchEventTouchesUsageStore(filename?: string | Buffer | null): boolean {
  if (filename == null) return true;
  const value = typeof filename === "string" ? filename : filename.toString("utf8");
  return value.endsWith(".jsonl") || value.endsWith(".meta.json");
}

function markStoreDirty(force = false) {
  const state = globalThis.__usageStoreWatchState;
  if (!state) return;
  if (!force && Date.now() < state.ignoreUntil) return;

  state.dirty = true;
  state.lastEventAt = Date.now();
}

function closeSourceWatchers(state?: UsageStoreWatchState) {
  if (!state) return;

  for (const watcher of state.watchers) {
    try {
      watcher.close();
    } catch {}
  }
}

function ensureSourceWatchers(sourceDirs: SourceDir[], sourcesKey: string): UsageStoreWatchState {
  const current = globalThis.__usageStoreWatchState;
  if (current?.key === sourcesKey) {
    return current;
  }

  closeSourceWatchers(current);

  const state: UsageStoreWatchState = {
    key: sourcesKey,
    watchers: [],
    dirty: false,
    lastEventAt: 0,
    ignoreUntil: Date.now() + 1_000,
    changedPaths: new Set(),
  };

  globalThis.__usageStoreWatchState = state;

  for (const source of sourceDirs) {
    if (!fs.existsSync(source.dir)) continue;

    try {
      const watcher = fs.watch(
        source.dir,
        { recursive: true },
        (_eventType, filename) => {
          if (watchEventTouchesUsageStore(filename)) {
            markStoreDirty();
            if (filename) {
              const name = String(filename);
              let jsonlPath: string | null = null;
              if (name.endsWith(".jsonl")) {
                jsonlPath = path.join(source.dir, name);
              } else if (name.endsWith(".meta.json")) {
                jsonlPath = path.join(source.dir, name.replace(/\.meta\.json$/, ".jsonl"));
              }
              if (jsonlPath) {
                state.changedPaths.add(jsonlPath);
              }
            }
          }
        }
      );
      watcher.on("error", () => {
        markStoreDirty(true);
      });
      state.watchers.push(watcher);
    } catch {
      // Fall back to periodic reconcile when recursive watch is unavailable.
    }
  }

  return state;
}

function getDb(): DatabaseSync {
  if (!globalThis.__usageStoreDb) {
    ensureCacheDir();

    const db = new DatabaseSync(DB_FILE);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = OFF;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        source_dir TEXT NOT NULL,
        source_label TEXT,
        project TEXT NOT NULL,
        observed_size INTEGER NOT NULL,
        last_offset INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        meta_size INTEGER NOT NULL DEFAULT 0,
        meta_mtime_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS usage_entries (
        event_key TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_type TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_usage_entries_timestamp ON usage_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_entries_session_id ON usage_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_entries_project ON usage_entries(project);
      CREATE INDEX IF NOT EXISTS idx_usage_entries_file_path ON usage_entries(file_path);
    `);

    ensureMetadataDefaults(db);
    globalThis.__usageStoreDb = db;
  }

  return globalThis.__usageStoreDb;
}

function ensureMetadataDefaults(db: DatabaseSync) {
  if (getMetadata(db, "data_revision") == null) {
    setMetadata(db, "data_revision", "0");
  }
  if (getMetadata(db, "sources_hash") == null) {
    setMetadata(db, "sources_hash", "");
  }
  if (getMetadata(db, "updated_at") == null) {
    setMetadata(db, "updated_at", "0");
  }
}

function getMetadata(db: DatabaseSync, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMetadata(db: DatabaseSync, key: string, value: string) {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function bumpRevision(db: DatabaseSync): number {
  const current = Number(getMetadata(db, "data_revision") ?? "0");
  const next = current + 1;
  setMetadata(db, "data_revision", String(next));
  setMetadata(db, "updated_at", String(Date.now()));
  return next;
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
      // Skip inaccessible directories.
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
    const project =
      segments.length > 3 ? segments.slice(-3).join("/") : segments.slice(-2).join("/");
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
  const metaFile = jsonlFile.replace(/\.jsonl$/, ".meta.json");
  try {
    if (fs.existsSync(metaFile)) {
      const data = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
      return data.agentType || undefined;
    }
  } catch {}
  return undefined;
}

function getSourceDirs(): { dirs: SourceDir[]; primaryEnabled: boolean; sources: DataSource[] } {
  const config = loadSourcesConfig();
  const dirs: SourceDir[] = [];

  if (config.primaryEnabled) {
    dirs.push({ dir: CLAUDE_DIR });
  }

  for (const source of config.sources) {
    if (source.enabled && source.path && fs.existsSync(source.path)) {
      dirs.push({ dir: source.path, label: source.label });
    }
  }

  return { dirs, primaryEnabled: config.primaryEnabled, sources: config.sources };
}

function getMetaStats(jsonlFile: string): { metaSize: number; metaMtimeMs: number } {
  const metaFile = jsonlFile.replace(/\.jsonl$/, ".meta.json");

  try {
    if (!fs.existsSync(metaFile)) {
      return { metaSize: 0, metaMtimeMs: 0 };
    }

    const stat = fs.statSync(metaFile);
    return { metaSize: stat.size, metaMtimeMs: stat.mtimeMs };
  } catch {
    return { metaSize: 0, metaMtimeMs: 0 };
  }
}

function buildScannedFiles(sourceDirs: SourceDir[]): ScannedFile[] {
  const scanned: ScannedFile[] = [];

  for (const source of sourceDirs) {
    if (!fs.existsSync(source.dir)) continue;

    const files = findJsonlFiles(source.dir);
    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        const meta = getMetaStats(filePath);

        scanned.push({
          path: filePath,
          sourceDir: source.dir,
          sourceLabel: source.label ?? null,
          project: extractProjectName(filePath, source.dir, source.label),
          observedSize: stat.size,
          lastOffset: 0,
          mtimeMs: stat.mtimeMs,
          metaSize: meta.metaSize,
          metaMtimeMs: meta.metaMtimeMs,
        });
      } catch {
        // Skip unreadable files.
      }
    }
  }

  return scanned;
}

function readChunk(filePath: string, startOffset: number): { lines: string[]; nextOffset: number } {
  const stat = fs.statSync(filePath);
  if (startOffset >= stat.size) {
    return { lines: [], nextOffset: stat.size };
  }

  const length = stat.size - startOffset;
  const fd = fs.openSync(filePath, "r");

  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, startOffset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");

    if (text.length === 0) {
      return { lines: [], nextOffset: startOffset };
    }

    let processedText = text;
    if (!text.endsWith("\n") && !text.endsWith("\r")) {
      const lastNewline = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
      const trailingCandidate = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;

      try {
        JSON.parse(trailingCandidate);
      } catch {
        if (lastNewline < 0) {
          return { lines: [], nextOffset: startOffset };
        }
        processedText = text.slice(0, lastNewline + 1);
      }
    }

    const normalized = processedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n").filter(Boolean);
    const nextOffset = startOffset + Buffer.byteLength(processedText, "utf8");
    return { lines, nextOffset };
  } finally {
    fs.closeSync(fd);
  }
}

function buildEventKey(data: Record<string, unknown>, rawLine: string): string {
  const uuid = typeof data.uuid === "string" ? data.uuid : "";
  const requestId = typeof data.requestId === "string" ? data.requestId : "";

  if (uuid || requestId) {
    return `${uuid}:${requestId}`;
  }

  return createHash("sha1").update(rawLine).digest("hex");
}

function parseLines(
  lines: string[],
  project: string,
  agentType: string | undefined
): ParsedUsageEntry[] {
  const entries: ParsedUsageEntry[] = [];

  for (const line of lines) {
    if (!line.includes('"assistant"')) continue;

    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      if (data.type !== "assistant") continue;

      const usage = parseUsage(data);
      if (!usage) continue;

      const model = getModel(data);
      const timestamp = (data.timestamp as string) || "";
      const sessionId = (data.sessionId as string) || "";
      const cwd = (data.cwd as string) || "";

      entries.push({
        eventKey: buildEventKey(data, line),
        timestamp,
        sessionId,
        model,
        usage,
        cost: calculateCost(model, usage),
        project,
        cwd,
        type: "assistant",
        agentType: agentType ?? null,
      });
    } catch {
      // Skip malformed JSONL lines.
    }
  }

  return entries;
}

function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function upsertFileRecord(db: DatabaseSync, file: FileRecord) {
  db.prepare(`
    INSERT INTO files (
      path,
      source_dir,
      source_label,
      project,
      observed_size,
      last_offset,
      mtime_ms,
      meta_size,
      meta_mtime_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      source_dir = excluded.source_dir,
      source_label = excluded.source_label,
      project = excluded.project,
      observed_size = excluded.observed_size,
      last_offset = excluded.last_offset,
      mtime_ms = excluded.mtime_ms,
      meta_size = excluded.meta_size,
      meta_mtime_ms = excluded.meta_mtime_ms
  `).run(
    file.path,
    file.sourceDir,
    file.sourceLabel,
    file.project,
    file.observedSize,
    file.lastOffset,
    file.mtimeMs,
    file.metaSize,
    file.metaMtimeMs
  );
}

function deleteFileData(db: DatabaseSync, filePath: string) {
  db.prepare("DELETE FROM usage_entries WHERE file_path = ?").run(filePath);
  db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
}

function insertEntries(db: DatabaseSync, filePath: string, entries: ParsedUsageEntry[]) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO usage_entries (
      event_key,
      file_path,
      timestamp,
      session_id,
      model,
      input_tokens,
      output_tokens,
      cache_creation_tokens,
      cache_read_tokens,
      cost,
      project,
      cwd,
      type,
      agent_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entry of entries) {
    stmt.run(
      entry.eventKey,
      filePath,
      entry.timestamp,
      entry.sessionId,
      entry.model,
      entry.usage.input_tokens,
      entry.usage.output_tokens,
      entry.usage.cache_creation_input_tokens,
      entry.usage.cache_read_input_tokens,
      entry.cost,
      entry.project,
      entry.cwd,
      entry.type,
      entry.agentType
    );
  }
}

function listExistingFiles(db: DatabaseSync): Map<string, FileRecord> {
  const rows = db.prepare(`
    SELECT
      path,
      source_dir AS sourceDir,
      source_label AS sourceLabel,
      project,
      observed_size AS observedSize,
      last_offset AS lastOffset,
      mtime_ms AS mtimeMs,
      meta_size AS metaSize,
      meta_mtime_ms AS metaMtimeMs
    FROM files
  `).all() as unknown as FileRecord[];

  return new Map(rows.map((row) => [row.path, row]));
}

function listEntries(db: DatabaseSync): UsageEntry[] {
  const rows = db.prepare(`
    SELECT
      timestamp,
      session_id AS sessionId,
      model,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cache_creation_tokens AS cacheCreationTokens,
      cache_read_tokens AS cacheReadTokens,
      cost,
      project,
      cwd,
      type,
      agent_type AS agentType
    FROM usage_entries
    ORDER BY timestamp ASC, event_key ASC
  `).all() as unknown as Array<{
    timestamp: string;
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
    project: string;
    cwd: string;
    type: string;
    agentType: string | null;
  }>;

  return rows.map((row) => ({
    timestamp: row.timestamp,
    sessionId: row.sessionId,
    model: row.model,
    usage: {
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cache_creation_input_tokens: row.cacheCreationTokens,
      cache_read_input_tokens: row.cacheReadTokens,
    },
    cost: row.cost,
    project: row.project,
    cwd: row.cwd,
    type: row.type,
    ...(row.agentType ? { agentType: row.agentType } : {}),
  }));
}

function buildMeta(db: DatabaseSync): UsageStoreMeta {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM usage_entries) AS entriesCount,
      (SELECT COUNT(*) FROM files) AS fileCount
  `).get() as { entriesCount: number; fileCount: number };

  return {
    revision: Number(getMetadata(db, "data_revision") ?? "0"),
    entriesCount: Number(counts.entriesCount ?? 0),
    fileCount: Number(counts.fileCount ?? 0),
    sourcesHash: getMetadata(db, "sources_hash") ?? "",
    updatedAt: Number(getMetadata(db, "updated_at") ?? "0"),
    dbPath: DB_FILE,
  };
}

function processFileChange(
  db: DatabaseSync,
  file: ScannedFile,
  mode: "rebuild" | "append",
  startOffset: number
) {
  const agentType = readAgentType(file.path);
  const { lines, nextOffset } = readChunk(file.path, startOffset);
  const entries = parseLines(lines, file.project, agentType);

  withTransaction(db, () => {
    if (mode === "rebuild") {
      db.prepare("DELETE FROM usage_entries WHERE file_path = ?").run(file.path);
    }

    insertEntries(db, file.path, entries);
    upsertFileRecord(db, {
      ...file,
      lastOffset: nextOffset,
    });
  });
}

function buildTargetedScan(changedPaths: Set<string>, sourceDirs: SourceDir[]): ScannedFile[] {
  const scanned: ScannedFile[] = [];

  for (const filePath of changedPaths) {
    if (!filePath.endsWith(".jsonl")) continue;

    const source = sourceDirs.find((s) => filePath.startsWith(s.dir));
    if (!source) continue;

    try {
      if (!fs.existsSync(filePath)) continue;

      const stat = fs.statSync(filePath);
      const meta = getMetaStats(filePath);

      scanned.push({
        path: filePath,
        sourceDir: source.dir,
        sourceLabel: source.label ?? null,
        project: extractProjectName(filePath, source.dir, source.label),
        observedSize: stat.size,
        lastOffset: 0,
        mtimeMs: stat.mtimeMs,
        metaSize: meta.metaSize,
        metaMtimeMs: meta.metaMtimeMs,
      });
    } catch {
      // Skip unreadable files.
    }
  }

  return scanned;
}

export function syncUsageStore(onProgress?: ProgressCallback): UsageStoreSyncResult {
  const progress = onProgress ?? (() => {});
  const now = Date.now();
  const lastSync = globalThis.__usageStoreLastSync;

  const startTime = Date.now();
  const db = getDb();
  const { dirs: sourceDirs, primaryEnabled, sources } = getSourceDirs();
  const currentSourcesHash = getSourcesHash(primaryEnabled, sources);
  const watchState = ensureSourceWatchers(sourceDirs, currentSourcesHash);

  if (
    lastSync &&
    currentSourcesHash === lastSync.result.meta.sourcesHash &&
    !watchState.dirty &&
    now - lastSync.at < STORE_RECONCILE_MS
  ) {
    progress(
      "done",
      `No source changes detected (${lastSync.result.meta.entriesCount} entries cached)`,
      lastSync.result.meta.entriesCount,
      lastSync.result.meta.entriesCount
    );
    return lastSync.result;
  }

  const previousSourcesHash = getMetadata(db, "sources_hash") ?? "";
  const sourcesChanged = previousSourcesHash !== "" && previousSourcesHash !== currentSourcesHash;

  // Targeted scan: when watcher tracked specific files, skip full directory scan
  const lastFullSyncAt = globalThis.__usageStoreLastFullSync ?? 0;
  const canDoTargetedSync =
    lastSync &&
    !sourcesChanged &&
    watchState.dirty &&
    watchState.changedPaths.size > 0 &&
    watchState.changedPaths.size <= 50 &&
    now - lastFullSyncAt < FULL_RECONCILE_MS;

  if (canDoTargetedSync) {
    progress("check", `Targeted check of ${watchState.changedPaths.size} changed file(s)...`);

    const changedScanned = buildTargetedScan(watchState.changedPaths, sourceDirs);
    const existingFiles = listExistingFiles(db);
    let changed = false;
    let processedFiles = 0;

    // Check for deletions among tracked paths
    for (const changedPath of watchState.changedPaths) {
      if (!changedPath.endsWith(".jsonl")) continue;
      if (existingFiles.has(changedPath) && !fs.existsSync(changedPath)) {
        deleteFileData(db, changedPath);
        changed = true;
      }
    }

    for (const file of changedScanned) {
      const existing = existingFiles.get(file.path);

      if (!existing) {
        processFileChange(db, file, "rebuild", 0);
        changed = true;
        processedFiles++;
        continue;
      }

      if (file.metaSize !== existing.metaSize || file.metaMtimeMs !== existing.metaMtimeMs) {
        processFileChange(db, file, "rebuild", 0);
        changed = true;
        processedFiles++;
        continue;
      }

      if (file.observedSize < existing.observedSize || file.observedSize < existing.lastOffset) {
        processFileChange(db, file, "rebuild", 0);
        changed = true;
        processedFiles++;
        continue;
      }

      if (file.observedSize === existing.observedSize && file.mtimeMs !== existing.mtimeMs) {
        processFileChange(db, file, "rebuild", 0);
        changed = true;
        processedFiles++;
        continue;
      }

      if (file.observedSize > existing.observedSize) {
        processFileChange(db, file, "append", existing.lastOffset);
        changed = true;
        processedFiles++;
      }
    }

    setMetadata(db, "sources_hash", currentSourcesHash);
    if (changed) {
      bumpRevision(db);
    }

    const meta = buildMeta(db);
    progress(
      "done",
      changed
        ? `Targeted sync: ${processedFiles} file(s) updated in ${Date.now() - startTime}ms`
        : `No changes in tracked files (${meta.entriesCount} entries)`,
      meta.entriesCount,
      meta.entriesCount
    );

    watchState.changedPaths.clear();
    watchState.dirty = watchState.lastEventAt > now;
    watchState.ignoreUntil = Date.now() + 2_000;

    const result: UsageStoreSyncResult = {
      meta,
      changed,
      scannedFiles: changedScanned.length,
      processedFiles,
    };

    globalThis.__usageStoreLastSync = { at: Date.now(), result };
    return result;
  }

  // Full scan path
  progress("scan", "Scanning data sources...");
  progress("scan", `Scanning ${sourceDirs.length} source(s) for JSONL files...`);

  const scannedFiles = buildScannedFiles(sourceDirs);
  const scannedPaths = new Set(scannedFiles.map((file) => file.path));

  progress("scan", `Found ${scannedFiles.length} JSONL files`, scannedFiles.length, scannedFiles.length);
  progress("check", "Checking SQLite cache for file changes...");

  const existingFiles = listExistingFiles(db);
  let changed = false;
  let processedFiles = 0;

  if (sourcesChanged) {
    progress("check", "Sources config changed, rebuilding tracked files...");
  }

  for (const existingPath of existingFiles.keys()) {
    if (scannedPaths.has(existingPath)) continue;

    deleteFileData(db, existingPath);
    changed = true;
  }

  const toProcess: Array<{ file: ScannedFile; mode: "rebuild" | "append"; startOffset: number }> = [];

  for (const file of scannedFiles) {
    const existing = existingFiles.get(file.path);

    if (!existing || sourcesChanged) {
      toProcess.push({ file, mode: "rebuild", startOffset: 0 });
      continue;
    }

    if (file.metaSize !== existing.metaSize || file.metaMtimeMs !== existing.metaMtimeMs) {
      toProcess.push({ file, mode: "rebuild", startOffset: 0 });
      continue;
    }

    if (file.observedSize < existing.observedSize || file.observedSize < existing.lastOffset) {
      toProcess.push({ file, mode: "rebuild", startOffset: 0 });
      continue;
    }

    if (file.observedSize === existing.observedSize && file.mtimeMs !== existing.mtimeMs) {
      toProcess.push({ file, mode: "rebuild", startOffset: 0 });
      continue;
    }

    if (file.observedSize > existing.observedSize) {
      toProcess.push({ file, mode: "append", startOffset: existing.lastOffset });
    }
  }

  progress(
    "check",
    `${scannedFiles.length - toProcess.length} cached, ${toProcess.length} to process`,
    toProcess.length,
    scannedFiles.length
  );

  if (toProcess.length > 0) {
    progress("process", `Processing ${toProcess.length} changed/new files...`, 0, toProcess.length);

    for (let i = 0; i < toProcess.length; i++) {
      const task = toProcess[i];
      try {
        processFileChange(db, task.file, task.mode, task.startOffset);
        changed = true;
        processedFiles += 1;
      } catch (error) {
        console.error(`[usage-store] Failed to process ${task.file.path}:`, error);
      }

      if (i % 5 === 0 || i === toProcess.length - 1) {
        progress("process", `Processing file ${i + 1}/${toProcess.length}`, i + 1, toProcess.length);
      }
    }
  }

  setMetadata(db, "sources_hash", currentSourcesHash);
  if (changed) {
    bumpRevision(db);
  }

  const meta = buildMeta(db);
  progress(
    "done",
    changed
      ? `SQLite cache updated: ${meta.entriesCount} entries in ${Date.now() - startTime}ms`
      : `SQLite cache is current: ${meta.entriesCount} entries`,
    meta.entriesCount,
    meta.entriesCount
  );

  const result: UsageStoreSyncResult = {
    meta,
    changed,
    scannedFiles: scannedFiles.length,
    processedFiles,
  };

  globalThis.__usageStoreLastFullSync = Date.now();
  if (globalThis.__usageStoreWatchState?.key === currentSourcesHash) {
    globalThis.__usageStoreWatchState.changedPaths.clear();
    globalThis.__usageStoreWatchState.dirty =
      globalThis.__usageStoreWatchState.lastEventAt > now;
    globalThis.__usageStoreWatchState.ignoreUntil = Date.now() + 2_000;
  }

  globalThis.__usageStoreLastSync = { at: Date.now(), result };
  return result;
}

export function getUsageStoreMeta(): UsageStoreMeta {
  return buildMeta(getDb());
}

export function loadUsageEntriesFromStore(): UsageEntry[] {
  return listEntries(getDb());
}

export function readAllUsageDataFromStore(onProgress?: ProgressCallback): UsageEntry[] {
  syncUsageStore(onProgress);
  return loadUsageEntriesFromStore();
}
