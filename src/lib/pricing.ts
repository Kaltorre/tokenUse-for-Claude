import { TokenUsage } from "./types";

// Pricing per million tokens (USD) — updated March 2026
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
export interface ModelPricing {
  input: number;
  output: number;
  cache5mWrite: number;   // 5-minute cache write (1.25x input)
  cache1hWrite: number;   // 1-hour cache write (2x input)
  cacheRead: number;      // cache hit/read (0.1x input)
}

export interface PricingRow {
  key: string;       // e.g. "opus-4-6"
  label: string;     // e.g. "Opus 4.6"
  family: "opus" | "sonnet" | "haiku";
  pricing: ModelPricing;
}

// Per-version pricing for accurate cost calculation
const VERSION_PRICING: Record<string, ModelPricing> = {
  // Opus 4.6 & 4.5 — new lower pricing
  "opus-4-6":  { input: 5,  output: 25, cache5mWrite: 6.25,  cache1hWrite: 10,   cacheRead: 0.50 },
  "opus-4-5":  { input: 5,  output: 25, cache5mWrite: 6.25,  cache1hWrite: 10,   cacheRead: 0.50 },
  // Opus 4.1 & 4 — legacy pricing
  "opus-4-1":  { input: 15, output: 75, cache5mWrite: 18.75, cache1hWrite: 30,   cacheRead: 1.50 },
  "opus-4":    { input: 15, output: 75, cache5mWrite: 18.75, cache1hWrite: 30,   cacheRead: 1.50 },
  // Sonnet — stable pricing across versions
  "sonnet-4-6": { input: 3, output: 15, cache5mWrite: 3.75, cache1hWrite: 6,    cacheRead: 0.30 },
  "sonnet-4-5": { input: 3, output: 15, cache5mWrite: 3.75, cache1hWrite: 6,    cacheRead: 0.30 },
  "sonnet-4":   { input: 3, output: 15, cache5mWrite: 3.75, cache1hWrite: 6,    cacheRead: 0.30 },
  // Haiku
  "haiku-4-5": { input: 1,    output: 5,    cache5mWrite: 1.25, cache1hWrite: 2,    cacheRead: 0.10 },
  "haiku-3-5": { input: 0.80, output: 4,    cache5mWrite: 1.00, cache1hWrite: 1.60, cacheRead: 0.08 },
  "haiku-3":   { input: 0.25, output: 1.25, cache5mWrite: 0.30, cache1hWrite: 0.50, cacheRead: 0.03 },
};

// Ordered display table for the Pricing tab
export const PRICING_TABLE: PricingRow[] = [
  { key: "opus-4-6",    label: "Opus 4.6",    family: "opus",   pricing: VERSION_PRICING["opus-4-6"] },
  { key: "opus-4-5",    label: "Opus 4.5",    family: "opus",   pricing: VERSION_PRICING["opus-4-5"] },
  { key: "opus-4-1",    label: "Opus 4.1",    family: "opus",   pricing: VERSION_PRICING["opus-4-1"] },
  { key: "opus-4",      label: "Opus 4",      family: "opus",   pricing: VERSION_PRICING["opus-4"] },
  { key: "sonnet-4-6",  label: "Sonnet 4.6",  family: "sonnet", pricing: VERSION_PRICING["sonnet-4-6"] },
  { key: "sonnet-4-5",  label: "Sonnet 4.5",  family: "sonnet", pricing: VERSION_PRICING["sonnet-4-5"] },
  { key: "sonnet-4",    label: "Sonnet 4",    family: "sonnet", pricing: VERSION_PRICING["sonnet-4"] },
  { key: "haiku-4-5",   label: "Haiku 4.5",   family: "haiku",  pricing: VERSION_PRICING["haiku-4-5"] },
  { key: "haiku-3-5",   label: "Haiku 3.5",   family: "haiku",  pricing: VERSION_PRICING["haiku-3-5"] },
  { key: "haiku-3",     label: "Haiku 3",     family: "haiku",  pricing: VERSION_PRICING["haiku-3"] },
];

// Fallback family-level pricing (uses latest version pricing)
const FAMILY_PRICING: Record<string, ModelPricing> = {
  opus:   VERSION_PRICING["opus-4-6"],
  sonnet: VERSION_PRICING["sonnet-4-6"],
  haiku:  VERSION_PRICING["haiku-4-5"],
};

export function getModelPricing(model: string): ModelPricing {
  const lower = model.toLowerCase();

  // Try exact version match first (longest key first to avoid partial matches)
  const sortedKeys = Object.keys(VERSION_PRICING).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    const pattern = new RegExp(key.replace(/-/g, "[- _.]*"));
    if (pattern.test(lower)) {
      return VERSION_PRICING[key];
    }
  }

  // Try extracting family + version from model string
  // e.g. "claude-opus-4-6" -> "opus-4-6", "Opus 4.6" -> "opus-4-6"
  const match = lower.match(/(opus|sonnet|haiku)[- _.]*(\d+)[- _.]*(\d+)?/);
  if (match) {
    const family = match[1];
    const major = match[2];
    const minor = match[3];
    const versionKey = minor ? `${family}-${major}-${minor}` : `${family}-${major}`;
    if (VERSION_PRICING[versionKey]) return VERSION_PRICING[versionKey];
  }

  // Fallback to family
  if (lower.includes("opus")) return FAMILY_PRICING.opus;
  if (lower.includes("haiku")) return FAMILY_PRICING.haiku;
  return FAMILY_PRICING.sonnet;
}

const EXTENDED_CONTEXT_THRESHOLD = 200_000;

/**
 * Context tier multiplier for requests exceeding 200K context tokens.
 * Anthropic charges higher prices for extended context (>200K input tokens).
 * Opus/Sonnet: 2× pricing, Haiku: 1.5× pricing.
 */
function getContextTierMultiplier(model: string, contextTokens: number): number {
  if (contextTokens <= EXTENDED_CONTEXT_THRESHOLD) return 1;
  const lower = model.toLowerCase();
  if (lower.includes("haiku")) return 1.5;
  return 2; // opus, sonnet
}

export function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = getModelPricing(model);

  // Context size = what the model "sees" as input context
  const contextTokens = usage.input_tokens + usage.cache_read_input_tokens;
  const tierMultiplier = getContextTierMultiplier(model, contextTokens);

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input * tierMultiplier;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output * tierMultiplier;
  // Cache creation tokens — use 1h write price (Claude Code uses 1h caching by default)
  const cacheCreationCost = (usage.cache_creation_input_tokens / 1_000_000) * pricing.cache1hWrite * tierMultiplier;
  const cacheReadCost = (usage.cache_read_input_tokens / 1_000_000) * pricing.cacheRead * tierMultiplier;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

export function getModelDisplayName(model: string): string {
  if (!model) return "unknown";
  const lower = model.toLowerCase();

  const families = ["opus", "sonnet", "haiku"] as const;
  for (const family of families) {
    if (lower.includes(family)) {
      const ver = lower.match(new RegExp(`${family}[- _]?(\\d+)[- _]?(\\d+)?`));
      const name = family.charAt(0).toUpperCase() + family.slice(1);
      return ver ? `${name} ${ver[1]}${ver[2] ? "." + ver[2] : ""}` : name;
    }
  }
  return model;
}
