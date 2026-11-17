"use client";

// Optional promo banner shown at the top of every page. Driven entirely by env:
// NEXT_PUBLIC_FRIDAY_BANNER_URL (empty = hidden) and NEXT_PUBLIC_FRIDAY_BANNER_TEXT.
export default function OwnerBanner() {
  const href = (process.env.NEXT_PUBLIC_FRIDAY_BANNER_URL || "").trim();
  if (!href) return null;
  const text = (process.env.NEXT_PUBLIC_FRIDAY_BANNER_TEXT || "").trim() || href;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="owner-banner"
      style={{
        position: "sticky", top: 0, zIndex: 50,
        display: "flex", alignItems: "center", justifyContent: "center", gap: "16px",
        padding: "16px 24px", marginBottom: "16px",
        background: "linear-gradient(90deg, #d9b36a, #e8c98a)",
        border: "1px solid rgba(0,0,0,.25)", borderRadius: "14px",
        boxShadow: "0 6px 22px rgba(0,0,0,.35)", textDecoration: "none",
        fontSize: "16.5px", fontWeight: 700, color: "#161018", textAlign: "center",
        flexWrap: "wrap", cursor: "pointer",
      }}
    >
      <span>{text}</span>
    </a>
  );
}
