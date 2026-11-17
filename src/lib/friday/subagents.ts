// FRIDAY's department roster (JARVIS-pivot A3, plan §7.2/§10) — seven sub-agents over agent-core's
// workerpool. Parent ∩ subset enforced in code; unknown names fail safe to nothing; nothing here
// can exceed FRIDAY's own gates (deploy/rollback keep their Tier-3 floor from inside a sub-run).

import os from "node:os";
import path from "node:path";
import type { SubAgentDef } from "@autom8ionlab/agent-core";
import { OWNER_FIRST } from "@/lib/friday/persona";

export const SOULS_DIR = process.env.ORION_SOULS_DIR ?? path.join(os.homedir(), ".agentic-os", "souls");

export const SUBAGENTS: SubAgentDef[] = [
  {
    id: "builder",
    name: "Builder",
    parent: "friday",
    description: "Feature and fix implementation via the task pipeline.",
    tools: ["dispatch_task", "list_projects", "project_status", "create_doc"],
  },
  {
    id: "qa-e2e",
    name: "QA / E2E",
    parent: "friday",
    description: "Verification — site health, deploy states, test dispatches.",
    tools: ["site_health", "read_deploys", "dispatch_task", "list_projects"],
  },
  {
    id: "devops-deploy",
    name: "DevOps / Deploy",
    parent: "friday",
    description: `Ships and un-ships — deploys, rollbacks, provisioning. Everything irreversible still queues for ${OWNER_FIRST}.`,
    tools: ["deploy", "rollback_deploy", "read_deploys", "site_health", "provision_workspace"],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    parent: "friday",
    description: "Second-opinion reviews of work in the pipeline.",
    tools: ["dispatch_task", "list_projects", "project_status"],
  },
  {
    id: "project-manager",
    name: "Project Manager",
    parent: "friday",
    description: "Status, health, and coordination across projects and clients.",
    tools: ["project_status", "list_projects", "client_health", "recent_meetings", "dispatch_task"],
  },
  {
    id: "client-comms",
    name: "Client Comms",
    parent: "friday",
    description: "Client-facing updates — always gated before anything sends.",
    tools: ["weekly_update", "client_health", "find_contact", "create_doc"],
  },
  {
    id: "docs-sop",
    name: "Docs / SOP",
    parent: "friday",
    description: "Documentation and process write-ups, including deep document builds.",
    tools: ["create_doc", "drive_search", "deep_work", "recent_meetings"],
  },
];

export function subAgentById(id: string): SubAgentDef | undefined {
  return SUBAGENTS.find((s) => s.id === id);
}
