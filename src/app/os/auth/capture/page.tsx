"use client";

// Capture page for FRIDAY's Orion sign-in. Supabase redirects here after Google OAuth with the
// session in the URL fragment (#access_token=…&refresh_token=…). Fragments never reach the server,
// so this client page pulls them out and POSTs them to /api/os/auth/callback, then scrubs the
// fragment from history so the tokens don't linger in the address bar.
import { useEffect, useState } from "react";

export default function OsAuthCapture() {
  const [msg, setMsg] = useState("Connecting FRIDAY to Orion…");

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    const err = hash.get("error_description") || hash.get("error");
    if (err) {
      setMsg(`Sign-in failed: ${err}`);
      return;
    }
    if (!access_token || !refresh_token) {
      setMsg("No tokens in the redirect — did the Google sign-in complete?");
      return;
    }
    fetch("/api/os/auth/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token, refresh_token }),
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean; email?: string; error?: string }) => {
        window.history.replaceState(null, "", window.location.pathname);
        setMsg(j.ok ? `Connected as ${j.email}. You can close this tab.` : `Failed: ${j.error}`);
      })
      .catch((e) => setMsg(`Failed: ${String(e)}`));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 40, maxWidth: 560 }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Orion connection</h1>
      <p>{msg}</p>
    </main>
  );
}
