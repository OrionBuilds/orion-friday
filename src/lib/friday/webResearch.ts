// FRIDAY — lightweight external research: read a web page, a YouTube transcript, or an RSS feed.
// Zero-config only (no login/cookies, no credentialed platforms) — Jina Reader's free proxy for
// arbitrary pages, yt-dlp for YouTube transcripts, and a direct XML parse for RSS/Atom feeds (no
// Python/feedparser dependency — one less thing that has to be separately installed/on PATH).
//
// Every function: explicit timeout, never throws into a caller's reply-generation path (returns ""
// on any failure), and caps its output before it can bloat a prompt — same discipline as the
// existing context blocks (recallBlock, shippedBlock) in emailAgent.ts/orchestrator.ts.
//
// yt-dlp must be on PATH for readYouTube() to work (see docs/AGENT-REACH.md for the installer that
// sets this up — run by the owner, not FRIDAY). curl is assumed present (already required by the
// rest of the toolchain).

import { runProcess } from "@autom8ionlab/agent-core";
import { ENV_OPTIONS } from "@/lib/runner";
import { logEvent } from "@/lib/persistence/store";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_CHARS = 8_000; // capped before it ever reaches a prompt

function cap(text: string): string {
  const t = text.trim();
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n…(truncated)` : t;
}

const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i;

/** Is this a YouTube link? readUrl() delegates to readYouTube() for these automatically. */
export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_RE.test(url);
}

// The first http(s) URL in a block of free text, if any — used by callers deciding whether to
// pre-fetch context for a client message. Deliberately simple (no query-string edge cases needed
// here); good enough to catch "check this out: https://…" style asks.
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"')]+/i;
export function firstUrlIn(text: string): string | null {
  const m = URL_IN_TEXT_RE.exec(text || "");
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null; // trim trailing sentence punctuation
}

/**
 * Fetch a web page's clean text via Jina Reader's free proxy (r.jina.ai). Delegates to
 * readYouTube() for YouTube links — Jina Reader renders the player chrome, not a transcript.
 */
export async function readUrl(url: string): Promise<string> {
  if (isYouTubeUrl(url)) return readYouTube(url);
  try {
    const res = await runProcess("curl", ["-sL", "--max-time", "15", `https://r.jina.ai/${url}`], {
      timeoutMs: FETCH_TIMEOUT_MS,
      envOptions: ENV_OPTIONS,
    });
    if (!res.ok || !res.stdout.trim()) {
      await logEvent("webresearch.read_url_failed", { url, code: res.code, stderr: res.stderr.slice(0, 200) }, { level: "warn" }).catch(() => {});
      return "";
    }
    return cap(res.stdout);
  } catch (e) {
    await logEvent("webresearch.read_url_error", { url, error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
    return "";
  }
}

// WebVTT → plain text: drop the header, cue-number lines, timing lines, inline tags
// (<c>, <00:00:01.000>), and collapse the auto-caption pattern of each line repeating the
// previous one as captions scroll.
function vttToText(vtt: string): string {
  const lines = vtt
    .split(/\r?\n/)
    .filter((l) => l.trim() && l.trim() !== "WEBVTT")
    .filter((l) => !/^\d+$/.test(l.trim())) // cue numbers
    .filter((l) => !/-->/.test(l)) // timing lines
    .map((l) => l.replace(/<[^>]+>/g, "").trim()) // inline tags
    .filter(Boolean);
  const deduped: string[] = [];
  for (const l of lines) if (deduped[deduped.length - 1] !== l) deduped.push(l);
  return deduped.join(" ");
}

/** Extract a YouTube video's subtitles/auto-captions via yt-dlp. Empty string on any failure. */
export async function readYouTube(url: string): Promise<string> {
  const { mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "friday-yt-"));
    const out = path.join(dir, "sub");
    const res = await runProcess("yt-dlp", [
      "--skip-download",
      "--write-auto-sub", "--write-sub",
      "--sub-lang", "en.*",
      "--sub-format", "vtt",
      "--output", out,
      url,
    ], { timeoutMs: FETCH_TIMEOUT_MS, envOptions: ENV_OPTIONS });
    if (!res.ok) {
      await logEvent("webresearch.read_youtube_failed", { url, code: res.code, stderr: res.stderr.slice(0, 200) }, { level: "warn" }).catch(() => {});
      return "";
    }
    const files = await readdir(dir).catch(() => [] as string[]);
    const vttFile = files.find((f) => f.endsWith(".vtt"));
    if (!vttFile) return "";
    const vtt = await readFile(path.join(dir, vttFile), "utf8");
    return cap(vttToText(vtt));
  } catch (e) {
    await logEvent("webresearch.read_youtube_error", { url, error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
    return "";
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

interface RssItem { title: string; summary: string; link: string }

// Minimal RSS 2.0 / Atom item extraction — deliberately regex-based rather than pulling in an XML
// parser dependency for what's a well-bounded, tolerant-of-malformed-feeds task. Good enough for a
// context block; not a general-purpose feed reader.
function parseFeedItems(xml: string, max: number): RssItem[] {
  const items: RssItem[] = [];
  const blockRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  const fieldRe = (tag: string) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const unescape = (s: string) =>
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
  let m: RegExpExecArray | null;
  while (items.length < max && (m = blockRe.exec(xml))) {
    const block = m[0];
    const title = unescape(fieldRe("title").exec(block)?.[1] ?? "");
    const summary = unescape((fieldRe("description").exec(block) ?? fieldRe("summary").exec(block))?.[1] ?? "");
    const linkMatch = fieldRe("link").exec(block)?.[1] ?? /<link[^>]*\shref=["']([^"']+)["']/i.exec(block)?.[1] ?? "";
    if (title) items.push({ title, summary: summary.slice(0, 300), link: unescape(linkMatch) });
  }
  return items;
}

/** Fetch an RSS/Atom feed and return a short digest of its most recent entries. */
export async function readRss(url: string, max = 8): Promise<string> {
  try {
    const res = await runProcess("curl", ["-sL", "--max-time", "15", url], {
      timeoutMs: FETCH_TIMEOUT_MS,
      envOptions: ENV_OPTIONS,
    });
    if (!res.ok || !res.stdout.trim()) {
      await logEvent("webresearch.read_rss_failed", { url, code: res.code }, { level: "warn" }).catch(() => {});
      return "";
    }
    const items = parseFeedItems(res.stdout, max);
    if (!items.length) return "";
    return cap(items.map((it) => `- ${it.title}${it.summary ? ` — ${it.summary}` : ""} (${it.link})`).join("\n"));
  } catch (e) {
    await logEvent("webresearch.read_rss_error", { url, error: String(e).slice(0, 200) }, { level: "warn" }).catch(() => {});
    return "";
  }
}
