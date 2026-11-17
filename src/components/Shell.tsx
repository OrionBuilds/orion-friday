"use client";

import type { ReactNode } from "react";
import { Shell as SharedShell } from "@autom8ionlab/agent-core";
import Sidebar, { MobileNav } from "./Sidebar";
import TopBar from "./TopBar";
import OwnerBanner from "./OwnerBanner";

export default function Shell({ children }: { children: ReactNode }) {
  return (
    <SharedShell sidebar={<Sidebar />} mobileNav={<MobileNav />} topBar={<TopBar />} banner={<OwnerBanner />}>
      {children}
    </SharedShell>
  );
}
