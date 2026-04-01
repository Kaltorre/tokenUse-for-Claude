import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadSourcesConfig } from "./sources-config";

const CLAUDE_DIR = path.join(os.homedir(), ".claude", "projects");

export interface SearchMatch {
  role: "user" | "assistant";
  text: string;
  matchStart: number;
  matchLength: number;
  timestamp: string;
}

export interface SearchResult {
  sessionId: string;
  project: string;
  cwd: string;
  filePath: string;
  firstTimestamp: string;
  matches: SearchMatch[];
  totalMatches: number;
}

interface SourceDir {
  dir: string;
  label?: string;
}

interface CandidateFile {
  filePath: string;
  source: SourceDir;
  mtimeMs: number;
}

function getSourceDirs(): SourceDir[] {
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

  return dirs;
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

function extractSessionId(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

/**
 * Enumerate JSONL files from all sources, filter by date, sort newest first.
 */
function enumerateFiles(
  sourceDirs: SourceDir[],
  includeSubagents: boolean,
  cutoffMs: number
): CandidateFile[] {
  const files: CandidateFile[] = [];

  for (const source of sourceDirs) {
    if (!fs.existsSync(source.dir)) continue;

    const stack = [source.dir];
    while (stack.length > 0) {
      const currentDir = stack.pop()!;
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            if (!includeSubagents && entry.name === "subagents") continue;
            stack.push(fullPath);
          } else if (entry.name.endsWith(".jsonl")) {
            try {
              const mtimeMs = fs.statSync(fullPath).mtimeMs;
              if (cutoffMs > 0 && mtimeMs < cutoffMs) continue;
              files.push({ filePath: fullPath, source, mtimeMs });
            } catch {}
          }
        }
      } catch {}
    }
  }

  // Sort newest first
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function buildSnippet(
  fullText: string,
  matchIndex: number,
  queryLength: number,
  contextChars: number = 100
): { text: string; matchStart: number; matchLength: number } {
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(fullText.length, matchIndex + queryLength + contextChars);

  let snippet = fullText.slice(start, end);
  let matchStart = matchIndex - start;

  if (start > 0) {
    snippet = "..." + snippet;
    matchStart += 3;
  }
  if (end < fullText.length) {
    snippet = snippet + "...";
  }

  const cleaned = snippet.replace(/\n+/g, " ").replace(/\s+/g, " ");
  const beforeMatch = snippet.slice(0, matchStart).replace(/\n+/g, " ").replace(/\s+/g, " ");
  matchStart = beforeMatch.length;

  return { text: cleaned, matchStart, matchLength: queryLength };
}

/**
 * Single-pass search within one JSONL file.
 * First does a fast Buffer check for the query string,
 * then parses only lines containing the query for snippets.
 */
function searchInFile(
  filePath: string,
  queryLower: string,
  queryLength: number,
  maxMatches: number
): { matches: SearchMatch[]; totalMatches: number; cwd: string; firstTimestamp: string } | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Fast pre-check: does the file even contain the query?
  if (!content.toLowerCase().includes(queryLower)) return null;

  const matches: SearchMatch[] = [];
  let totalMatches = 0;
  let cwd = "";
  let firstTimestamp = "";
  const lines = content.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    // Extract session metadata
    if (!cwd && line.includes('"sessionId"') && line.includes('"cwd"')) {
      try {
        const d = JSON.parse(line);
        cwd = d.cwd || "";
        if (!firstTimestamp) firstTimestamp = d.timestamp || "";
      } catch {}
    }

    // Only process user/assistant lines that contain the query
    const isUser = line.includes('"type":"user"');
    const isAssistant = line.includes('"type":"assistant"');
    if (!isUser && !isAssistant) continue;
    if (!line.toLowerCase().includes(queryLower)) continue;

    try {
      const data = JSON.parse(line);
      if (data.isMeta) continue;

      const timestamp = data.timestamp || "";
      if (!firstTimestamp) firstTimestamp = timestamp;

      const message = data.message;
      if (!message?.content) continue;

      const texts: string[] = [];
      const msgContent = message.content;

      if (typeof msgContent === "string") {
        texts.push(msgContent);
      } else if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block?.type === "text" && block.text) {
            texts.push(block.text);
          }
        }
      }

      const fullText = texts.join("\n");
      if (!fullText.trim()) continue;

      if (
        fullText.startsWith("<system-reminder>") ||
        fullText.startsWith("<local-command-caveat>") ||
        fullText.startsWith("<task-notification>") ||
        fullText.startsWith("<command-name>")
      ) continue;

      const role = data.type as "user" | "assistant";
      const textLower = fullText.toLowerCase();
      let searchFrom = 0;

      while (true) {
        const idx = textLower.indexOf(queryLower, searchFrom);
        if (idx === -1) break;

        totalMatches++;
        if (matches.length < maxMatches) {
          const snippet = buildSnippet(fullText, idx, queryLength);
          matches.push({
            role,
            text: snippet.text,
            matchStart: snippet.matchStart,
            matchLength: snippet.matchLength,
            timestamp,
          });
        }

        searchFrom = idx + queryLower.length;
      }
    } catch {}
  }

  if (matches.length === 0) return null;
  return { matches, totalMatches, cwd, firstTimestamp };
}

export function searchSessions(
  query: string,
  limit: number = 50,
  maxMatchesPerSession: number = 5,
  includeSubagents: boolean = false,
  days: number = 30
): SearchResult[] {
  if (!query || query.trim().length < 2) return [];

  const trimmedQuery = query.trim();
  const queryLower = trimmedQuery.toLowerCase();
  const sourceDirs = getSourceDirs();
  const cutoffMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;

  // Phase 1: enumerate files filtered by date (fast — readdir + stat only)
  const candidates = enumerateFiles(sourceDirs, includeSubagents, cutoffMs);

  // Phase 2: search within each file (fast pre-check + targeted parse)
  const results: SearchResult[] = [];

  for (const { filePath, source } of candidates) {
    if (results.length >= limit) break;

    const result = searchInFile(filePath, queryLower, trimmedQuery.length, maxMatchesPerSession);
    if (!result) continue;

    results.push({
      sessionId: extractSessionId(filePath),
      project: extractProjectName(filePath, source.dir, source.label),
      cwd: result.cwd,
      filePath,
      firstTimestamp: result.firstTimestamp,
      matches: result.matches,
      totalMatches: result.totalMatches,
    });
  }

  // Already sorted by mtime from enumeration, re-sort by session timestamp
  results.sort((a, b) => {
    if (!a.firstTimestamp) return 1;
    if (!b.firstTimestamp) return -1;
    return new Date(b.firstTimestamp).getTime() - new Date(a.firstTimestamp).getTime();
  });

  return results.slice(0, limit);
}
