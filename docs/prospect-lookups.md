# Prospect lookups — CLARA → FRIDAY (Agent-Reach stays pinned to FRIDAY)

Part of the Prospect Intelligence Engine (plan 2026-09-30, PR 4b). CLARA's research engine needs
owner names from LinkedIn and page text / web search through Exa and Jina. Those tools live
behind `reach-guard`, which is pinned to FRIDAY's `research-qa` role only (owner decisions
2026-09-20 and 2026-09-30: CLARA never touches the owner's social accounts). So CLARA asks
FRIDAY, over the existing interagent boundary, and gets a **typed** answer.

**Endpoint:** `POST /api/friday/prospect/lookup` — gated by `verifyInteragentSecret`
(`x-interagent-secret`, or loopback). Deterministic: no planner, no task, no agent run. Every
guarded call is audited under `REACH_AGENT=friday:research-qa` in `~/.agent-reach/guard-audit.jsonl`.

Shared types and a never-throwing client live in agent-core: `src/interagent/prospect.ts`
(`ProspectLookupRequest`, `ProspectLookupResponse`, `postProspectLookup(base, req)`).

## Request

```jsonc
{ "from": "clara", "kind": "prospect.linkedin_lookup", "ref": "job:…:company:…",
  "input": { "company": { "name": "Acme Roofing Co", "domain": "acmeroofing.example.com", "city": "Tampa", "state": "FL" },
             "personas": ["Owner", "President", "General Manager"],
             "max_profiles": 2,                 // 0–3 profile pages to open (each = one LinkedIn "view")
             "include_company_profile": false } // also open the company page (one more "view")
}
{ "from": "clara", "kind": "prospect.web_read", "input": { "mode": "read",   "url": "https://acmeroofing.example.com/about" } }
{ "from": "clara", "kind": "prospect.web_read", "input": { "mode": "search", "query": "Acme Roofing Co Tampa owner", "num_results": 8 } }
```

## Response

LinkedIn (`ok: true`):
```jsonc
{ "ok": true, "kind": "prospect.linkedin_lookup",
  "company_profile": { "linkedin_url": "https://www.linkedin.com/company/acme-roofing-co/", "headcount": "11-50", "founded": "2008", "hq": "Tampa, FL" },
  "people": [ { "full_name": "John Smith", "title": "Owner & President at Acme Roofing Co", "linkedin_url": "https://www.linkedin.com/in/johnsmith-example/",
                "location": "Tampa, Florida, United States", "confidence": 0.9, "matched_persona": "Owner",
                "source_url": "https://www.linkedin.com/in/johnsmith-example/", "observed_at": "2026-09-30T15:02:11.000Z" } ],
  "budget": { "searches_used": 3, "views_used": 4, "remaining_today": { "searches": 7, "views": 21 } },
  "skipped_reason": null,           // or "linkedin_budget_exhausted" | "linkedin_outside_hours" | "linkedin_locked" | "linkedin_kill_switch" | "linkedin_disabled" | "linkedin_refused: …"
  "raw_excerpts": [ { "call": "search_people keywords=Acme Roofing Co location=Tampa, FL", "text": "…≤4 KB of what the tool returned…" } ],
  "observed_at": "2026-09-30T15:02:11.000Z" }
```
Confidence: 0.9 = profile opened and the title matches a requested persona; 0.7 = opened, title
differs; 0.6 = search hit with a persona match; 0.4 = search hit only. **Never** an email or a
phone number — LinkedIn's tools expose none and scraping them is out of bounds.

Web read: `{ ok, kind:"prospect.web_read", mode:"read", text, fetched_at, source:"jina" }` or
`{ …, mode:"search", results:[{title,url,snippet,published}], source:"exa" }`.

Errors (`ok: false`) carry the guard's verdict and the HTTP status mirrors it:

| HTTP | Flag | Meaning | Caller's move |
|---|---|---|---|
| 429 | `refused` | reach-guard exit 64: cap reached, outside Mon–Fri 08–18, disabled, kill switch | Don't retry today. |
| 423 | `locked` | exit 75: LinkedIn pushed back (captcha / "unusual activity"); 72 h lock | Stop the platform, tell the owner. |
| 409 | `not_logged_in` | exit 69 | Only the owner can log in. |
| 400 | — | bad input | Fix the request. |
| 502 | — | backend failure | Retry later. |

A pre-spend budget check (mirroring the guard: today's counts, caps, hours, locks, STOP file)
returns `ok:true` with `skipped_reason` and no calls made, so an exhausted day never costs a
refused attempt. A refusal that hits mid-lookup keeps the partial result.

## Budget rules

Shared with FRIDAY's own Wednesday "Weekly lead research" schedule, because both go through the
same guard state: **10 searches + 25 profile views per day, Mon–Fri 08:00–18:00 local, 45–120 s
between calls, at most 4 calls per lookup** (company search → optional company page → people
search → up to 2 profiles). A 2-profile lookup therefore takes 3–6 minutes; `postProspectLookup`
defaults to an 8-minute timeout, so call it detached. Owner controls are unchanged
(`~/.agent-reach/PINS.md`): `touch ~/.agent-reach/STOP` halts everything.

## Parsing

LinkedIn's MCP returns raw page text. The parsers are URL-anchored and tolerant: each
`linkedin.com/company/<slug>` / `/in/<user>` occurrence becomes a candidate with the nearest
lines as name and title. The raw excerpts travel back so CLARA's model can re-read them when a
title looks off. Everything fetched is untrusted content.
