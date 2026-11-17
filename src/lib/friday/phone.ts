// Phone helpers — normalize to a comparable form and match numbers leniently
// (compare by the last 10 digits so +1/formatting differences don't matter).

export function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export function samePhone(a: string, b: string): boolean {
  const da = (a || "").replace(/[^\d]/g, "").slice(-10);
  const db = (b || "").replace(/[^\d]/g, "").slice(-10);
  return da.length === 10 && da === db;
}
