// Recurring agent schedules — the cadence matcher + CRUD. The scheduler's `scheduled-agent-tasks`
// job (scheduler.ts) calls `scheduleDue()` each tick and dispatches due ones; the UI/API use the CRUD
// wrappers + the human/next-run helpers. Recurrence lives on the Schedule entity (Task has none).

import { store, newId, nowISO } from "@/lib/persistence/store";
import type { Schedule } from "@/lib/friday/types";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function lastDayOfMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

// Is this schedule due to fire at `now` (owner local time)? Fires at most once per due day, gated on
// its lastRunAt. Monthly clamps an out-of-range dayOfMonth to the month's last day (e.g. 31 → Feb 28).
export function scheduleDue(s: Schedule, now: Date): boolean {
  if (!s.enabled) return false;
  const minute = s.minute ?? 0;
  const afterTime = now.getHours() > s.hour || (now.getHours() === s.hour && now.getMinutes() >= minute);
  if (!afterTime) return false;
  if (s.freq === "weekly" && now.getDay() !== s.dayOfWeek) return false;
  if (s.freq === "monthly") {
    const dom = Math.min(s.dayOfMonth ?? 1, lastDayOfMonth(now));
    if (now.getDate() !== dom) return false;
  }
  if (s.lastRunAt && sameLocalDay(new Date(s.lastRunAt), now)) return false; // already fired today
  return true;
}

// Human-readable cadence, e.g. "Weekly · Mon 09:00".
export function describeCadence(s: Schedule): string {
  const t = `${String(s.hour).padStart(2, "0")}:${String(s.minute ?? 0).padStart(2, "0")}`;
  if (s.freq === "daily") return `Daily · ${t}`;
  if (s.freq === "weekly") return `Weekly · ${DOW[s.dayOfWeek ?? 1]} ${t}`;
  return `Monthly · day ${s.dayOfMonth ?? 1} · ${t}`;
}

// The next time this schedule will fire (for the UI). Null if disabled or none found within a year.
export function nextRun(s: Schedule, from = new Date()): Date | null {
  if (!s.enabled) return null;
  const minute = s.minute ?? 0;
  for (let i = 0; i < 400; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, s.hour, minute, 0, 0);
    if (d <= from) continue;
    if (s.freq === "weekly" && d.getDay() !== s.dayOfWeek) continue;
    if (s.freq === "monthly" && d.getDate() !== Math.min(s.dayOfMonth ?? 1, lastDayOfMonth(d))) continue;
    return d;
  }
  return null;
}

// ── CRUD ──────────────────────────────────────────────────────────────────
export async function listSchedules(): Promise<Schedule[]> {
  return store.schedules.all();
}
export async function createSchedule(input: Partial<Schedule>): Promise<Schedule> {
  const now = nowISO();
  const s: Schedule = {
    id: newId(),
    name: input.name?.trim() || "Untitled schedule",
    enabled: input.enabled ?? true,
    targetType: input.targetType ?? "project",
    projectId: input.projectId,
    clientId: input.clientId,
    assignee: input.assignee || "pm",
    title: input.title?.trim() || "Scheduled task",
    description: input.description,
    risk: input.risk ?? "low",
    freq: input.freq ?? "weekly",
    dayOfWeek: input.dayOfWeek,
    dayOfMonth: input.dayOfMonth,
    hour: typeof input.hour === "number" ? input.hour : 9,
    minute: input.minute,
    createdAt: now, updatedAt: now,
  };
  return store.schedules.insert(s);
}
export async function updateSchedule(id: string, patch: Partial<Schedule>): Promise<Schedule | null> {
  return store.schedules.update(id, { ...patch, updatedAt: nowISO() });
}
export async function deleteSchedule(id: string): Promise<boolean> {
  return store.schedules.remove(id);
}
