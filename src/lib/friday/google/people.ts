// Google People API — search saved Contacts and "Other contacts" (people you email
// with but haven't saved) to autofill the new-client form.
//
// Two sources, merged + deduped by email:
//   people:searchContacts    — your saved contacts (rich: org + address available)
//   otherContacts:search     — auto-collected from mail (names/emails/phones only)
//
// Both search endpoints are cache-backed and Google recommends priming the cache with a
// warmup (empty-query) request; we fire one lazily on the first real search.
import { gfetch } from "./auth";

const CONTACTS_MASK = "names,emailAddresses,phoneNumbers,organizations,addresses";
const OTHER_MASK = "names,emailAddresses,phoneNumbers";

export interface ContactHit {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  source: "contact" | "other";
}

// A single person as returned by the People API (only the fields we read).
interface Person {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
  addresses?: { streetAddress?: string; city?: string; region?: string; postalCode?: string }[];
}

function toHit(p: Person, source: ContactHit["source"]): ContactHit | null {
  const name = p.names?.[0]?.displayName?.trim();
  const email = p.emailAddresses?.[0]?.value?.trim();
  if (!name && !email) return null;
  const org = p.organizations?.[0];
  const addr = p.addresses?.[0];
  return {
    name: name || email || "",
    email,
    phone: p.phoneNumbers?.[0]?.value?.trim(),
    company: org?.name?.trim(),
    jobTitle: org?.title?.trim(),
    addressLine: addr?.streetAddress?.trim(),
    city: addr?.city?.trim(),
    state: addr?.region?.trim(),
    postalCode: addr?.postalCode?.trim(),
    source,
  };
}

let warmed = false;
async function warmup(): Promise<void> {
  if (warmed) return;
  warmed = true;
  // Empty-query calls just prime Google's search cache — ignore the result.
  await Promise.allSettled([
    gfetch(`https://people.googleapis.com/v1/people:searchContacts?query=&readMask=${CONTACTS_MASK}`),
    gfetch(`https://people.googleapis.com/v1/otherContacts:search?query=&readMask=${OTHER_MASK}`),
  ]).catch(() => {});
}

// Search both sources; returns up to `max` merged, deduped hits. Saved contacts rank first
// (they're richer). Throws only on auth failure — callers gate on that.
export async function searchContacts(query: string, max = 8): Promise<ContactHit[]> {
  const q = query.trim();
  if (q.length < 2) { void warmup(); return []; }
  await warmup();

  const [cRes, oRes] = await Promise.allSettled([
    gfetch(`https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(q)}&pageSize=${max}&readMask=${CONTACTS_MASK}`),
    gfetch(`https://people.googleapis.com/v1/otherContacts:search?query=${encodeURIComponent(q)}&pageSize=${max}&readMask=${OTHER_MASK}`),
  ]);

  const hits: ContactHit[] = [];
  let okCount = 0;
  let apiError: string | null = null;
  const collect = async (res: PromiseSettledResult<Response>, source: ContactHit["source"]) => {
    if (res.status === "rejected") { apiError ??= String(res.reason); return; }
    if (!res.value.ok) { apiError ??= `People API ${res.value.status}: ${(await res.value.text().catch(() => "")).slice(0, 160)}`; return; }
    okCount++;
    const j = await res.value.json();
    for (const r of j.results ?? []) { const h = toHit(r.person ?? {}, source); if (h) hits.push(h); }
  };
  await collect(cRes, "contact");
  await collect(oRes, "other");

  // Both calls failed (bad scope, People API disabled, etc.) — surface it so the UI can
  // tell the user to reconnect / enable the API, rather than showing a misleading "no matches".
  if (okCount === 0 && apiError) throw new Error(apiError);

  // Dedup by email (fallback to lowercased name); saved contacts already come first.
  const seen = new Set<string>();
  const deduped: ContactHit[] = [];
  for (const h of hits) {
    const key = (h.email || h.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
  }
  return deduped.slice(0, max);
}
