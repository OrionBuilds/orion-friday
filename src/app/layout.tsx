import type { Metadata } from "next";
import "./globals.css";
import Shell from "@/components/Shell";

export const metadata: Metadata = {
  title: "FRIDAY — Orion",
  description: "Mission control for FRIDAY and the agent team",
};

// Orion slate + cyan design system (2026-07-23). No web fonts —
// the Orion design spec uses stock
// system-sans + system-mono; the previous Google Fonts quartet (Bricolage
// Grotesque · Manrope · Caveat · JetBrains Mono) is dropped for brand
// consistency across every Orion surface.

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <div className="relative z-10">
          <Shell>{children}</Shell>
        </div>
      </body>
    </html>
  );
}
