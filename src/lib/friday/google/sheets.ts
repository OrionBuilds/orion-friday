import { gfetch } from "./auth";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function quoteRange(sheet: string, a1: string): string {
  return encodeURIComponent(`'${sheet.replace(/'/g, "''")}'!${a1}`);
}

export async function readColumn(spreadsheetId: string, sheet: string, column: string): Promise<string[]> {
  const r = await gfetch(`${BASE}/${spreadsheetId}/values/${quoteRange(sheet, `${column}:${column}`)}`);
  if (!r.ok) return [];
  const j = (await r.json()) as { values?: string[][] };
  return (j.values ?? []).map((row) => row[0] ?? "");
}

export async function appendRows(spreadsheetId: string, sheet: string, rows: (string | number)[][]): Promise<{ ok: boolean; appended: number; error?: string }> {
  if (!rows.length) return { ok: true, appended: 0 };
  const r = await gfetch(`${BASE}/${spreadsheetId}/values/${quoteRange(sheet, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: rows }),
  });
  if (!r.ok) return { ok: false, appended: 0, error: `sheets ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  return { ok: true, appended: rows.length };
}
