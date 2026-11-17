// Which project a router-dispatched task lands on. Pure, so the precedence is testable without the
// router: the project the request names wins; otherwise the project the conversation is about (the
// chat's projectId — CLARA relays asks with one, and "this project" used to make the router stop and
// ask "which project?"); otherwise the first active project, as before.
export function resolveDispatchProject<P extends { id: string; name: string; status?: string }>(
  projects: P[],
  asked: string,
  currentId?: string,
): P | undefined {
  const q = asked.toLowerCase().trim();
  if (q) return projects.find((p) => p.id === asked || p.name.toLowerCase().includes(q));
  return (currentId ? projects.find((p) => p.id === currentId) : undefined) ?? projects.find((p) => p.status === "active");
}
