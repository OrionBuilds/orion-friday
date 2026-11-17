// FRIDAY ← Orion per-agent settings (OS Settings → AI Agents, edge function agent-settings-get).
//
// The OS now holds one effective configuration per agent key: `friday` for FRIDAY herself and
// `friday.<id>` for each department subagent (builder, qa-e2e, …) and dispatch specialist (architect,
// dev, qa, …). Every field is nullable and NULL means "keep the built-in default"; the OS resolves
// inheritance (subagent → friday → org defaults) before it answers, so this module only has to fetch,
// cache, and turn the answer into decisions.
//
// RULES THIS MODULE ENFORCES (pure helpers below, applied at the call sites):
//   - Never block FRIDAY on the OS. 15s fetch timeout, ~60s cache, last-good snapshot (memory, then
//     disk) on failure, and `null` (= built-in defaults everywhere) when there has never been one.
//   - Limits only NARROW the hard-coded caps (narrowCap). An OS value can never raise a cap.
//   - Tools only narrow: code catalog ∩ allowed − denied (filterTools). Never widen.
//   - Model and voice come from an EXPLICIT per-agent setting (source agent|parent). An org-wide
//     default (source org_default) is ignored unless FRIDAY_AGENT_SETTINGS_ORG_DEFAULTS=on — the OS
//     falls back to the org's default LLM/voice when FRIDAY has no row, and silently swapping her
//     router or phone voice to whatever the org default happens to be is not what "inherit" means here.
//   - status paused|disabled → refuse new work and say why (refusalFor).
//
// Kill switch: FRIDAY_AGENT_SETTINGS=off → every helper sees `null` and FRIDAY runs on her built-ins.

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

export const ROOT_AGENT_KEY = "friday";
export const SETTINGS_TTL_MS = 60_000;
export const SETTINGS_TIMEOUT_MS = 15_000;

export type AgentStatus = "active" | "paused" | "disabled";
export type SettingSource = "agent" | "parent" | "org_default" | "none";

export interface ModelChoice {
  id: string;
  model_key: string;
  provider: string | null;
  display_name?: string;
  max_output_tokens?: number | null;
  available: boolean;
  unavailable_reason?: string;
}

export interface AgentLimits {
  daily_budget_usd: number | null;
  max_tokens: number | null;
  max_calls_per_day: number | null;
  rate_limit_per_minute: number | null;
  max_turns: number | null;
}

export interface PromptTemplate { id: string; name: string; version: number | null; body: string }

export interface AgentSettingsEntry {
  agent_key: string;
  parent_key: string | null;
  display_name: string | null;
  status: AgentStatus;
  model: {
    effective: ModelChoice | null;
    primary: ModelChoice | null;
    primary_source: SettingSource;
    fallback: ModelChoice | null;
    fallback_source: SettingSource;
  };
  voice: {
    voice_id: string | null;
    voice_name: string | null;
    available: boolean | null;
    source: SettingSource;
    settings: Record<string, unknown>;
  };
  prompts: { persona_override: string | null; persona_mode: "append" | "replace"; templates: PromptTemplate[] };
  knowledge: { collections: { id: string; name: string }[]; include_global: boolean };
  tools: { allowed: string[] | null; denied: string[] };
  limits: AgentLimits;
  require_approval: boolean;
  updated_at: string | null;
}

export interface AgentSettingsSnapshot {
  root: AgentSettingsEntry;
  /** Keyed by full agent key, e.g. `friday.builder`. Only subagents with a settings row appear. */
  subagents: Record<string, AgentSettingsEntry>;
  generatedAt: string | null;
  /** epoch ms of the successful fetch this snapshot came from. */
  fetchedAt: number;
}

// ── Parsing (defensive: a malformed answer is a failed fetch, never a half-applied config) ────────

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const SOURCES: SettingSource[] = ["agent", "parent", "org_default", "none"];
const source = (v: unknown): SettingSource => (SOURCES.includes(v as SettingSource) ? (v as SettingSource) : "none");
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))) : [];

function parseModel(v: unknown): ModelChoice | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const model_key = str(m.model_key);
  if (!model_key) return null;
  return {
    id: str(m.id) ?? model_key,
    model_key,
    provider: str(m.provider)?.toLowerCase() ?? null,
    display_name: str(m.display_name) ?? undefined,
    max_output_tokens: numOrNull(m.max_output_tokens),
    available: m.available === true,
    ...(str(m.unavailable_reason) ? { unavailable_reason: String(m.unavailable_reason) } : {}),
  };
}

/** Parse one entry of the agent-settings-get answer. Returns null when it isn't recognisably one. */
export function parseEntry(v: unknown): AgentSettingsEntry | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const agent_key = str(e.agent_key);
  if (!agent_key) return null;
  const status: AgentStatus = e.status === "paused" || e.status === "disabled" ? e.status : "active";
  const model = (e.model ?? {}) as Record<string, unknown>;
  const voice = (e.voice ?? {}) as Record<string, unknown>;
  const prompts = (e.prompts ?? {}) as Record<string, unknown>;
  const knowledge = (e.knowledge ?? {}) as Record<string, unknown>;
  const tools = (e.tools ?? {}) as Record<string, unknown>;
  const limits = (e.limits ?? {}) as Record<string, unknown>;
  const templates: PromptTemplate[] = Array.isArray(prompts.templates)
    ? (prompts.templates as Record<string, unknown>[])
      .filter((t) => t && typeof t === "object" && str(t.body))
      .map((t) => ({ id: String(t.id ?? ""), name: str(t.name) ?? "template", version: numOrNull(t.version), body: String(t.body) }))
    : [];
  return {
    agent_key,
    parent_key: str(e.parent_key),
    display_name: str(e.display_name),
    status,
    model: {
      effective: parseModel(model.effective),
      primary: parseModel(model.primary),
      primary_source: source(model.primary_source),
      fallback: parseModel(model.fallback),
      fallback_source: source(model.fallback_source),
    },
    voice: {
      voice_id: str(voice.voice_id),
      voice_name: str(voice.voice_name),
      available: typeof voice.available === "boolean" ? voice.available : null,
      source: source(voice.source),
      settings: voice.settings && typeof voice.settings === "object" ? (voice.settings as Record<string, unknown>) : {},
    },
    prompts: {
      persona_override: str(prompts.persona_override),
      persona_mode: prompts.persona_mode === "replace" ? "replace" : "append",
      templates,
    },
    knowledge: {
      collections: Array.isArray(knowledge.collections)
        ? (knowledge.collections as Record<string, unknown>[]).map((c) => ({ id: String(c?.id ?? ""), name: String(c?.name ?? "") }))
        : [],
      include_global: knowledge.include_global !== false,
    },
    tools: { allowed: Array.isArray(tools.allowed) ? strList(tools.allowed) : null, denied: strList(tools.denied) },
    limits: {
      daily_budget_usd: numOrNull(limits.daily_budget_usd),
      max_tokens: numOrNull(limits.max_tokens),
      max_calls_per_day: numOrNull(limits.max_calls_per_day),
      rate_limit_per_minute: numOrNull(limits.rate_limit_per_minute),
      max_turns: numOrNull(limits.max_turns),
    },
    require_approval: e.require_approval === true,
    updated_at: str(e.updated_at),
  };
}

/** `{ success, data }` from agent-settings-get → snapshot. Throws on anything unusable. */
export function parseSettingsResponse(body: unknown, fetchedAt = Date.now()): AgentSettingsSnapshot {
  const b = (body ?? {}) as { success?: unknown; data?: unknown; error?: unknown };
  if (b.success !== true) throw new Error(`agent-settings-get: ${str(b.error) ?? "success=false"}`);
  const root = parseEntry(b.data);
  if (!root) throw new Error("agent-settings-get: no agent entry in data");
  if (root.agent_key !== ROOT_AGENT_KEY) throw new Error(`agent-settings-get answered for "${root.agent_key}", expected "${ROOT_AGENT_KEY}"`);
  const subagents: Record<string, AgentSettingsEntry> = {};
  const raw = (b.data as { subagents?: unknown }).subagents;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  for (const s of list) {
    const entry = parseEntry(s);
    if (entry && entry.agent_key.startsWith(`${ROOT_AGENT_KEY}.`)) subagents[entry.agent_key] = entry;
  }
  return { root, subagents, generatedAt: str((b.data as { generated_at?: unknown }).generated_at), fetchedAt };
}

// ── Fetch ────────────────────────────────────────────────────────────────────────────────────────

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  /** FRIDAY's OS user JWT. Default: osAuth.getFreshOsJwt() (same as msProjectFiles.ts). */
  getJwt?: () => Promise<string>;
  /** False → skip the fetch (FRIDAY isn't signed in to the OS). Default: osEnabled(). */
  enabled?: () => boolean;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => number;
}

export function osFunctionsBase(env: Record<string, string | undefined> = process.env): string {
  const url = env.ORION_SUPABASE_URL?.trim();
  if (!url) throw new Error("ORION_SUPABASE_URL is not set");
  return url.replace(/\/+$/, "");
}

/** One POST to agent-settings-get. Throws on any failure (the cache layer turns that into last-good). */
export async function fetchAgentSettings(deps: FetchDeps = {}): Promise<AgentSettingsSnapshot> {
  const os_ = deps.getJwt && deps.enabled ? null : await import("@/lib/friday/osClient");
  const enabled = deps.enabled ?? (() => os_!.osEnabled());
  if (!enabled()) throw new Error("FRIDAY is not signed in to the OS");
  const jwt = await (deps.getJwt ?? (() => os_!.osAuth.getFreshOsJwt()))();
  const doFetch = deps.fetchImpl ?? fetch;
  const r = await doFetch(`${deps.baseUrl ?? osFunctionsBase()}/functions/v1/agent-settings-get`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ include_subagents: true }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? SETTINGS_TIMEOUT_MS),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`agent-settings-get ${r.status}: ${str((j as { error?: unknown }).error) ?? "request failed"}`);
  return parseSettingsResponse(j, (deps.now ?? Date.now)());
}

// ── Cache (process-wide; survives Next HMR via globalThis) ───────────────────────────────────────

interface CacheState {
  snapshot: AgentSettingsSnapshot | null;
  lastAttemptAt: number;
  lastError: string | null;
  inflight: Promise<AgentSettingsSnapshot | null> | null;
  diskLoaded: boolean;
}
const g = globalThis as unknown as { __fridayAgentSettings?: CacheState };
function state(): CacheState {
  return (g.__fridayAgentSettings ??= { snapshot: null, lastAttemptAt: 0, lastError: null, inflight: null, diskLoaded: false });
}

/** Test hook. */
export function _resetAgentSettingsCache(snapshot: AgentSettingsSnapshot | null = null): void {
  g.__fridayAgentSettings = { snapshot, lastAttemptAt: 0, lastError: null, inflight: null, diskLoaded: true };
}

export function agentSettingsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FRIDAY_AGENT_SETTINGS ?? "on").trim().toLowerCase() !== "off";
}

function lastGoodFile(): string {
  const dir = process.env.AGENTIC_OS_FRIDAY_DATA ?? path.join(os.homedir(), ".agentic-os", "friday");
  return path.join(dir, "agent-settings.last-good.json");
}

async function loadDisk(): Promise<void> {
  const s = state();
  if (s.diskLoaded) return;
  s.diskLoaded = true;
  try {
    const parsed = JSON.parse(await fs.readFile(lastGoodFile(), "utf8")) as AgentSettingsSnapshot;
    if (!s.snapshot && parsed?.root?.agent_key === ROOT_AGENT_KEY) s.snapshot = parsed;
  } catch { /* no last-good yet */ }
}

async function saveDisk(snap: AgentSettingsSnapshot): Promise<void> {
  try {
    const file = lastGoodFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(snap), "utf8");
    await fs.rename(`${file}.tmp`, file);
  } catch { /* last-good on disk is a nicety */ }
}

async function noteError(msg: string): Promise<void> {
  const s = state();
  const changed = s.lastError !== msg;
  s.lastError = msg;
  if (!changed) return; // one log line per distinct failure, not one per minute
  try {
    const { logEvent } = await import("@/lib/persistence/store");
    await logEvent("agent_settings.fetch_failed", { error: msg.slice(0, 300), usingLastGood: !!s.snapshot }, { level: "warn" });
  } catch { /* logging must never break the caller */ }
}

/** Fetch now (single-flight). Resolves to the fresh snapshot, or the last good one on failure. */
export async function refreshAgentSettings(deps: FetchDeps = {}): Promise<AgentSettingsSnapshot | null> {
  if (!agentSettingsEnabled()) return null;
  const s = state();
  if (s.inflight) return s.inflight;
  s.lastAttemptAt = (deps.now ?? Date.now)();
  s.inflight = (async () => {
    await loadDisk();
    try {
      const snap = await fetchAgentSettings(deps);
      const prevStatus = s.snapshot?.root.status;
      s.snapshot = snap;
      s.lastError = null;
      void saveDisk(snap);
      if (prevStatus && prevStatus !== snap.root.status) {
        try {
          const { logEvent } = await import("@/lib/persistence/store");
          await logEvent("agent_settings.status_changed", { from: prevStatus, to: snap.root.status }, { level: "warn" });
        } catch { /* best-effort */ }
      }
      return snap;
    } catch (e) {
      await noteError(String(e instanceof Error ? e.message : e));
      return s.snapshot;
    } finally {
      s.inflight = null;
    }
  })();
  return s.inflight;
}

/**
 * The settings to act on right now. Fresh (<60s) → cached. Stale/cold → fetch, but wait at most
 * `maxWaitMs` (default: the full 15s fetch timeout); on timeout or failure → last good, else null.
 * A failed attempt is not retried for 60s, so an OS outage costs one wait per minute, not one per call.
 * Never throws.
 */
export async function getAgentSettings(opts: { force?: boolean; maxWaitMs?: number; deps?: FetchDeps } = {}): Promise<AgentSettingsSnapshot | null> {
  if (!agentSettingsEnabled()) return null;
  try {
    const s = state();
    await loadDisk();
    const now = (opts.deps?.now ?? Date.now)();
    if (!opts.force) {
      if (s.snapshot && now - s.snapshot.fetchedAt < SETTINGS_TTL_MS) return s.snapshot;
      if (s.lastError && now - s.lastAttemptAt < SETTINGS_TTL_MS) return s.snapshot;
    }
    const pending = refreshAgentSettings(opts.deps);
    if (opts.maxWaitMs === undefined) return await pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<AgentSettingsSnapshot | null>((resolve) => {
      timer = setTimeout(() => resolve(state().snapshot), opts.maxWaitMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return state().snapshot;
  }
}

/**
 * Synchronous read for sync call sites (caps, voice id, CLI allow-lists): the last good snapshot,
 * or null. When it is stale this also kicks a background refresh, so the next read is current.
 */
export function cachedAgentSettings(): AgentSettingsSnapshot | null {
  if (!agentSettingsEnabled()) return null;
  const s = state();
  const now = Date.now();
  const stale = !s.snapshot || now - s.snapshot.fetchedAt >= SETTINGS_TTL_MS;
  const backoff = s.lastError && now - s.lastAttemptAt < SETTINGS_TTL_MS;
  if (stale && !backoff && !s.inflight && !process.env.NODE_TEST_CONTEXT) void refreshAgentSettings().catch(() => {});
  return s.snapshot;
}

/** Diagnostics for /api/health-style surfaces. */
export function agentSettingsState(): { fetchedAt: number | null; lastError: string | null; status: AgentStatus | null } {
  const s = state();
  return { fetchedAt: s.snapshot?.fetchedAt ?? null, lastError: s.lastError, status: s.snapshot?.root.status ?? null };
}

// ── Pure policy helpers ──────────────────────────────────────────────────────────────────────────

/** "builder" | "friday.builder" → "friday.builder"; undefined/"friday" → "friday". */
export function agentKeyFor(id?: string | null): string {
  const v = (id ?? "").trim().toLowerCase();
  if (!v || v === ROOT_AGENT_KEY) return ROOT_AGENT_KEY;
  return v.startsWith(`${ROOT_AGENT_KEY}.`) ? v : `${ROOT_AGENT_KEY}.${v}`;
}

/**
 * The entry that governs `id`: its own row when the OS has one (already merged with FRIDAY's by the
 * OS: status worst-of, limits lower-of, tools narrowed), otherwise FRIDAY's root entry.
 */
export function settingsFor(snap: AgentSettingsSnapshot | null | undefined, id?: string | null): AgentSettingsEntry | null {
  if (!snap) return null;
  const key = agentKeyFor(id);
  if (key === ROOT_AGENT_KEY) return snap.root;
  return snap.subagents[key] ?? snap.root;
}

/**
 * Why new work must be refused, or null. Checks FRIDAY's own status and, for a subagent/specialist,
 * its row (the OS already folded FRIDAY's status into it — a paused FRIDAY pauses every subagent).
 */
export function refusalFor(snap: AgentSettingsSnapshot | null | undefined, id?: string | null): string | null {
  if (!snap) return null;
  const root = snap.root;
  if (root.status !== "active") {
    return `FRIDAY is ${root.status} in the OS (Settings → AI Agents), so I'm not starting new work. Set her back to active there to resume.`;
  }
  const key = agentKeyFor(id);
  const sub = key === ROOT_AGENT_KEY ? null : snap.subagents[key];
  if (sub && sub.status !== "active") {
    const name = sub.display_name ?? key.slice(ROOT_AGENT_KEY.length + 1);
    return `${name} is ${sub.status} in the OS (Settings → AI Agents), so that work isn't starting. Set it back to active there to resume.`;
  }
  return null;
}

/**
 * Narrow a hard-coded cap with an OS limit. The OS can only LOWER it: null/invalid/higher → the code
 * cap stands. `min` keeps counts usable (max_turns 0 would make the router unable to answer at all).
 */
export function narrowCap(codeCap: number, osLimit: number | null | undefined, opts: { min?: number; integer?: boolean } = {}): number {
  if (osLimit === null || osLimit === undefined || !Number.isFinite(osLimit) || osLimit < 0) return codeCap;
  let v = opts.integer ? Math.floor(osLimit) : osLimit;
  if (opts.min !== undefined) v = Math.max(opts.min, v);
  return Math.min(codeCap, v);
}

/** A cap that has no code-side equivalent (it narrows "unlimited"): positive finite → value, else null. */
export function osOnlyCap(osLimit: number | null | undefined): number | null {
  return osLimit !== null && osLimit !== undefined && Number.isFinite(osLimit) && osLimit >= 0 ? Math.floor(osLimit) : null;
}

export function orgDefaultsHonoured(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FRIDAY_AGENT_SETTINGS_ORG_DEFAULTS ?? "").trim().toLowerCase() === "on";
}

function sourceAllowed(src: SettingSource, includeOrgDefault: boolean): boolean {
  return src === "agent" || src === "parent" || (includeOrgDefault && src === "org_default");
}

/**
 * Models to try, in order, before the built-in default: the OS's effective model, then its fallback.
 * Only available models with a provider, only from an explicit setting (see header), deduped.
 */
export function modelCandidates(entry: AgentSettingsEntry | null | undefined, opts: { includeOrgDefault?: boolean } = {}): ModelChoice[] {
  if (!entry) return [];
  const includeOrg = opts.includeOrgDefault ?? orgDefaultsHonoured();
  const m = entry.model;
  const out: ModelChoice[] = [];
  const push = (c: ModelChoice | null, src: SettingSource) => {
    if (!c || !c.available || !c.provider || !c.model_key) return;
    if (!sourceAllowed(src, includeOrg)) return;
    if (out.some((o) => o.provider === c.provider && o.model_key === c.model_key)) return;
    out.push(c);
  };
  const eff = m.effective;
  const effSource: SettingSource = !eff ? "none"
    : m.primary && eff.id === m.primary.id ? m.primary_source
      : m.fallback && eff.id === m.fallback.id ? m.fallback_source
        : "org_default";
  push(eff, effSource);
  push(m.fallback, m.fallback_source);
  return out;
}

/**
 * Code catalog ∩ allowed − denied. Never adds anything.
 *
 * Tool names in the OS row can name FRIDAY's router tools (deploy, dispatch_task, …) or OS MCP tools
 * (contacts_list, …) — one list, two catalogs. `allowed` therefore narrows a catalog only when it
 * names at least one tool IN that catalog; a list written purely for the router must not silently
 * strip every OS MCP tool from a dispatched CLI run (or vice versa). `denied` always applies.
 */
export function filterTools<T>(items: readonly T[], nameOf: (t: T) => string, entry: AgentSettingsEntry | null | undefined): T[] {
  if (!entry) return [...items];
  const denied = new Set(entry.tools.denied);
  let out = items.filter((t) => !denied.has(nameOf(t)));
  const allowed = entry.tools.allowed;
  if (allowed) {
    const allow = new Set(allowed);
    if (items.some((t) => allow.has(nameOf(t)))) out = out.filter((t) => allow.has(nameOf(t)));
  }
  return out;
}

const PERSONA_MAX = 8_000;
const TEMPLATES_MAX = 12_000;

/**
 * Apply the OS persona to a PERSONA prompt (FRIDAY's soul, a subagent's soul). `replace` swaps it,
 * `append` adds to it; active prompt templates follow. Callers apply this to the persona part only —
 * the operational/tool-honesty prompt is never replaceable.
 */
export function applyPersona(base: string, entry: AgentSettingsEntry | null | undefined): string {
  if (!entry) return base;
  const override = entry.prompts.persona_override?.trim().slice(0, PERSONA_MAX) ?? "";
  let out = base;
  if (override) out = entry.prompts.persona_mode === "replace" || !base.trim() ? override : `${base}\n\n${override}`;
  let budget = TEMPLATES_MAX;
  const blocks: string[] = [];
  for (const t of entry.prompts.templates) {
    const body = t.body.trim();
    if (!body || budget <= 0) continue;
    const text = `## ${t.name}\n${body}`.slice(0, budget);
    budget -= text.length;
    blocks.push(text);
  }
  if (blocks.length) out = `${out}${out.trim() ? "\n\n---\n\n" : ""}${blocks.join("\n\n")}`;
  return out;
}

export interface VoiceOverride {
  voiceId: string | null;
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
}

/** OS voice for an entry (ElevenLabs id + 0..1 settings), or nulls → keep env/built-in voice. */
export function voiceFor(entry: AgentSettingsEntry | null | undefined, opts: { includeOrgDefault?: boolean } = {}): VoiceOverride {
  const out: VoiceOverride = { voiceId: null };
  if (!entry) return out;
  const v = entry.voice;
  const includeOrg = opts.includeOrgDefault ?? orgDefaultsHonoured();
  if (v.voice_id && v.available !== false && sourceAllowed(v.source, includeOrg) && /^[A-Za-z0-9]{16,}$/.test(v.voice_id)) {
    out.voiceId = v.voice_id;
  }
  const unit = (x: unknown): number | undefined => {
    const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
  };
  const s = v.settings;
  const stability = unit(s.stability);
  const similarity = unit(s.similarity_boost ?? s.similarity);
  const style = unit(s.style);
  if (stability !== undefined) out.stability = stability;
  if (similarity !== undefined) out.similarity_boost = similarity;
  if (style !== undefined) out.style = style;
  if (typeof s.use_speaker_boost === "boolean") out.use_speaker_boost = s.use_speaker_boost;
  return out;
}

// ── Per-minute rate limit (rate_limit_per_minute) ────────────────────────────────────────────────

const rateWindows = new Map<string, number[]>();

/** Take one slot in `key`'s 60s window. False = over the limit (the call must not go out). */
export function takeRateSlot(key: string, limitPerMinute: number | null, now = Date.now()): boolean {
  if (limitPerMinute === null) return true;
  const recent = (rateWindows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limitPerMinute) {
    rateWindows.set(key, recent);
    return false;
  }
  recent.push(now);
  rateWindows.set(key, recent);
  return true;
}

/** Test hook. */
export function _resetRateWindows(): void {
  rateWindows.clear();
}
