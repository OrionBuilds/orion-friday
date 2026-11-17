import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface Site {
  id: string;
  name: string;
  url: string;
  path: string;
  postsDir: string;
}

// The SEO funnel sites. Config-driven so no site is baked into the template:
// FRIDAY_SEO_SITES is a JSON array of {"id","name","url","path"[,"postsDir"]} ("path" may start
// with "~/"; "postsDir" defaults to <path>/src/blog/posts). Unset or invalid = no sites.
function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function loadSites(): Site[] {
  const raw = (process.env.FRIDAY_SEO_SITES || "").trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Partial<Site>[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.id === "string" && typeof x.path === "string")
      .map((x) => {
        const root = expandHome(String(x.path));
        return {
          id: String(x.id),
          name: String(x.name || x.id),
          url: String(x.url || ""),
          path: root,
          postsDir: x.postsDir ? expandHome(String(x.postsDir)) : path.join(root, "src/blog/posts"),
        };
      });
  } catch { return []; }
}

export const SITES: Site[] = loadSites();

// Where the SEO workspace keeps transcripts and the blog-post skill. FRIDAY_SEO_HOME, default ~/seo.
const SEO_HOME = expandHome((process.env.FRIDAY_SEO_HOME || "").trim() || "~/seo");
export const TRANSCRIPTS_DIR = path.join(SEO_HOME, ".claude", "transcripts");
export const BLOG_POST_SKILL = path.join(SEO_HOME, ".claude", "skills", "blog-post.md");

export interface SiteStats {
  site: Site;
  postCount: number;
  recent: { slug: string; mtime: number; title?: string; date?: string }[];
}

async function listFilesMtime(dir: string, n = 6): Promise<{ name: string; mtime: number }[]> {
  try {
    const items = await readdir(dir);
    const mds = items.filter((f) => /\.md$/.test(f));
    const stats = await Promise.all(mds.map(async (f) => {
      try { const s = await stat(path.join(dir, f)); return { name: f, mtime: s.mtimeMs }; }
      catch { return { name: f, mtime: 0 }; }
    }));
    stats.sort((a, b) => b.mtime - a.mtime);
    return stats.slice(0, n);
  } catch { return []; }
}

async function readFrontMatter(file: string): Promise<{ title?: string; date?: string }> {
  try {
    const data = await readFile(file, "utf8");
    const m = data.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return {};
    const fm = m[1];
    const titleMatch = fm.match(/^title:\s*["']?([^"'\n]+)["']?\s*$/m);
    const dateMatch = fm.match(/^date:\s*["']?([^"'\n]+)["']?\s*$/m);
    return {
      title: titleMatch ? titleMatch[1].trim() : undefined,
      date: dateMatch ? dateMatch[1].trim() : undefined,
    };
  } catch { return {}; }
}

export async function getSiteStats(site: Site): Promise<SiteStats> {
  const recent = await listFilesMtime(site.postsDir, 6);
  let postCount = 0;
  try { postCount = (await readdir(site.postsDir)).filter((f) => /\.md$/.test(f)).length; }
  catch {}
  const enriched = await Promise.all(recent.map(async (r) => {
    const fm = await readFrontMatter(path.join(site.postsDir, r.name));
    return { slug: r.name.replace(/\.md$/, ""), mtime: r.mtime, ...fm };
  }));
  return { site, postCount, recent: enriched };
}

export async function getAllSiteStats(): Promise<SiteStats[]> {
  return Promise.all(SITES.map(getSiteStats));
}

export interface TranscriptMeta { slug: string; bytes: number; mtime: number; preview: string; }

export async function listTranscripts(): Promise<TranscriptMeta[]> {
  try {
    const items = await readdir(TRANSCRIPTS_DIR);
    const txts = items.filter((f) => /\.txt$/.test(f));
    const out: TranscriptMeta[] = [];
    for (const t of txts) {
      const full = path.join(TRANSCRIPTS_DIR, t);
      try {
        const s = await stat(full);
        const head = (await readFile(full, "utf8")).slice(0, 220).replace(/\s+/g, " ").trim();
        out.push({ slug: t.replace(/\.txt$/, ""), bytes: s.size, mtime: s.mtimeMs, preview: head });
      } catch {}
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  } catch { return []; }
}

export async function readTranscript(slug: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) return null;
  const file = path.join(TRANSCRIPTS_DIR, `${slug}.txt`);
  try { return await readFile(file, "utf8"); }
  catch { return null; }
}
