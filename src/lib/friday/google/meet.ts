// Google Meet — pull recent conference records + their transcripts.
// Uses the Meet REST API v2 (scope meetings.space.readonly). Recordings/transcripts must be
// enabled on the meetings. Falls back to Drive-based transcript docs where the API is empty.
import { gfetch } from "./auth";
import { listFiles, readFileText } from "./drive";

const MEET = "https://meet.googleapis.com/v2";

export interface MeetingTranscript {
  conferenceRecord: string;
  startTime: string;
  endTime?: string;
  space?: string;
  participants: string[];
  text: string;
  source: "meet-api" | "drive";
  driveFileId?: string;
}

async function transcriptText(recordName: string): Promise<string> {
  const tl = await gfetch(`${MEET}/${recordName}/transcripts`);
  if (!tl.ok) return "";
  const transcripts = (await tl.json()).transcripts ?? [];
  const parts: string[] = [];
  for (const t of transcripts) {
    let pageToken = "";
    do {
      const r = await gfetch(`${MEET}/${t.name}/entries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`);
      if (!r.ok) break;
      const j = await r.json();
      for (const e of j.transcriptEntries ?? []) parts.push(`${e.participant?.split("/").pop() ?? "speaker"}: ${e.text}`);
      pageToken = j.nextPageToken ?? "";
    } while (pageToken);
  }
  return parts.join("\n");
}

export async function listRecentMeetings(days = 7, max = 10): Promise<MeetingTranscript[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const out: MeetingTranscript[] = [];
  try {
    const r = await gfetch(`${MEET}/conferenceRecords?filter=${encodeURIComponent(`start_time >= "${since}"`)}&pageSize=${max}`);
    if (r.ok) {
      const records = (await r.json()).conferenceRecords ?? [];
      for (const rec of records.slice(0, max)) {
        const text = await transcriptText(rec.name);
        if (!text) continue;
        // participants
        let participants: string[] = [];
        try {
          const pr = await gfetch(`${MEET}/${rec.name}/participants?pageSize=25`);
          if (pr.ok) participants = ((await pr.json()).participants ?? []).map((p: { signedinUser?: { displayName?: string }; anonymousUser?: { displayName?: string } }) => p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? "").filter(Boolean);
        } catch { /* ignore */ }
        out.push({ conferenceRecord: rec.name, startTime: rec.startTime, endTime: rec.endTime, space: rec.space, participants, text, source: "meet-api" });
      }
    }
  } catch { /* fall through to Drive */ }

  // Drive fallback: recent transcript/notes Google Docs (Meet saves these to Drive).
  if (!out.length) {
    const q = `(name contains 'Transcript' or name contains 'Notes by Gemini' or name contains 'Meeting notes') and mimeType = 'application/vnd.google-apps.document' and modifiedTime > '${since}' and trashed = false`;
    for (const f of await listFiles(q, max)) {
      const text = await readFileText(f.id, f.mimeType);
      if (text) out.push({ conferenceRecord: f.id, startTime: f.modifiedTime ?? "", participants: [], text, source: "drive", driveFileId: f.id });
    }
  }
  return out;
}
