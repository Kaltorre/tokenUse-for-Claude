import { DataSource, SourcesConfig, UsageEntry } from "./types";
import { getSourcesHash, loadSources, loadSourcesConfig } from "./sources-config";
import {
  ProgressCallback,
  ProgressStep,
  readAllUsageDataFromStore,
  syncUsageStore,
  loadUsageEntriesFromStore,
  getUsageStoreMeta,
  UsageStoreMeta,
  UsageStoreSyncResult,
} from "./usage-store";

export type { ProgressCallback, ProgressStep, UsageStoreMeta, UsageStoreSyncResult };

export { getSourcesHash, loadSources, loadSourcesConfig, getUsageStoreMeta, loadUsageEntriesFromStore, syncUsageStore };

export function readAllUsageData(onProgress?: ProgressCallback): UsageEntry[] {
  return readAllUsageDataFromStore(onProgress);
}

export function readSourcesConfig(): SourcesConfig {
  return loadSourcesConfig();
}

export function readSources(): DataSource[] {
  return loadSources();
}
