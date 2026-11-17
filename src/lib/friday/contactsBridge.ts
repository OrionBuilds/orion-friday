// M1 — FRIDAY's clients live in OS contacts; clients.json is a synced mirror.
//
// The ContactsSync engine (agent-core) pulls contact-native fields down from the OS and
// pushes FRIDAY-private fields (authorityProfile, bypassPolicy, drive folders, feedback
// stamps…) up into contact_agent_meta, so every existing store.clients.* call site — and
// the zero-latency inbound SMS/email sender matching — keeps working unchanged.
//
// refreshContacts() is TTL-gated (5 min) and never throws; the scheduler tick calls it,
// and repo.listClients() kicks it lazily so reads stay fresh even without the scheduler.

import { ContactsSync } from "@autom8ionlab/agent-core";
import type { Collection, Entity } from "@autom8ionlab/agent-core";
import { store, logEvent } from "@/lib/persistence/store";
import { osClient, osEnabled } from "@/lib/friday/osClient";
import type { Client } from "@/lib/friday/types";

export const contactsSync = new ContactsSync({
  agent: "friday",
  client: osClient,
  enabled: osEnabled,
  collection: store.clients as unknown as Collection<Entity & Record<string, unknown>>,
  log: (event, data) => void logEvent(event, data).catch(() => {}),
});

/** TTL-gated OS→local contacts refresh (never throws). */
export function refreshContacts(force = false): Promise<void> {
  return contactsSync.refresh(force);
}

type SyncRow = Entity & Record<string, unknown>;

/** Best-effort push of a locally-created client up to the OS. */
export function pushClientCreate(client: Client): void {
  void contactsSync.pushCreate(client as unknown as SyncRow).catch(() => {});
}

/** Best-effort push of a local client update up to the OS. */
export function pushClientUpdate(client: Client, patch: Partial<Client>): void {
  void contactsSync
    .pushUpdate(client as unknown as SyncRow, patch as Record<string, unknown>)
    .catch(() => {});
}

/** Best-effort archive marker (OS contact itself is never deleted by FRIDAY). */
export function pushClientArchive(client: Client): void {
  void contactsSync.pushArchive(client as unknown as SyncRow).catch(() => {});
}
