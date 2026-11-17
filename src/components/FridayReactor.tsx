"use client";

import { useEffect, useRef } from "react";

// FRIDAY's arc reactor — a self-contained, audio-reactive canvas core (adapted from the
// Apollo reactor). Reads `phase` + a live audio `level` (0-1) and renders the glowing
// rings/corona/core at 60fps without forcing React re-renders. Tap it to talk.

export type Phase = "idle" | "listening" | "thinking" | "speaking";

const VIOLET = "#22d3ee";
const CYAN = "#22d3ee";
const AMBER = "#f59e0b";
const GREEN = "#34d399";
export const phaseColor = (p: Phase) =>
  p === "listening" ? CYAN : p === "thinking" ? AMBER : p === "speaking" ? GREEN : VIOLET;

export const phaseLabel = (p: Phase) =>
  p === "listening" ? "LISTENING" : p === "thinking" ? "THINKING" : p === "speaking" ? "SPEAKING" : "ONLINE";

function Reactor({ phaseRef, levelRef, size }: { phaseRef: React.MutableRefObject<Phase>; levelRef: React.MutableRefObject<number>; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    cv.width = size * dpr; cv.height = size * dpr; ctx.scale(dpr, dpr);
    let raf = 0, t = 0;
    const hexToRgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };

    const draw = () => {
      t += 0.016;
      const [r, g, b] = hexToRgb(phaseColor(phaseRef.current));
      const rgba = (a: number) => `rgba(${r},${g},${b},${a})`;
      const cx = size / 2, cy = size / 2, R = size * 0.34;
      const lvl = levelRef.current;
      ctx.clearRect(0, 0, size, size);

      // ambient glow
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
      bg.addColorStop(0, rgba(0.12 + lvl * 0.12)); bg.addColorStop(0.6, rgba(0.03)); bg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);

      // outer tick ring
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 0.15); ctx.strokeStyle = rgba(0.5); ctx.lineWidth = 1;
      for (let i = 0; i < 72; i++) { const a = (i / 72) * Math.PI * 2; const long = i % 6 === 0; const r0 = R * 1.32, r1 = R * (long ? 1.42 : 1.37); ctx.globalAlpha = long ? 0.7 : 0.3; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke(); }
      ctx.restore(); ctx.globalAlpha = 1;

      // counter-rotating HUD arcs
      ctx.lineWidth = 2;
      for (let k = 0; k < 2; k++) { const dir = k === 0 ? 1 : -1; const rr = R * (1.12 + k * 0.1); const start = t * (0.6 + k * 0.5) * dir; ctx.strokeStyle = rgba(0.55 - k * 0.2); ctx.beginPath(); ctx.arc(cx, cy, rr, start, start + Math.PI * (0.6 - k * 0.15)); ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, rr, start + Math.PI, start + Math.PI + Math.PI * (0.6 - k * 0.15)); ctx.stroke(); }

      // reactive corona
      ctx.save(); ctx.translate(cx, cy); ctx.shadowBlur = 12; ctx.shadowColor = rgba(0.6);
      for (let i = 0; i < 96; i++) { const a = (i / 96) * Math.PI * 2; const n = 0.5 + 0.5 * Math.sin(i * 1.7 + t * 4); const len = R * (0.06 + (lvl * 0.5 + 0.08) * n); ctx.strokeStyle = rgba(0.25 + n * 0.5 * (0.3 + lvl)); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R + len), Math.sin(a) * (R + len)); ctx.stroke(); }
      ctx.restore();

      // core ring
      ctx.shadowBlur = 18; ctx.shadowColor = rgba(0.7); ctx.strokeStyle = rgba(0.85); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.62, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;

      // pulsing core
      const coreR = R * (0.30 + lvl * 0.22 + 0.03 * Math.sin(t * 3));
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      cg.addColorStop(0, "rgba(255,255,255,0.95)"); cg.addColorStop(0.4, rgba(0.85)); cg.addColorStop(1, rgba(0));
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

      // reactor vanes
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-t * 0.4); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) { ctx.rotate(Math.PI / 3); ctx.beginPath(); ctx.moveTo(0, -R * 0.34); ctx.lineTo(R * 0.10, -R * 0.50); ctx.lineTo(-R * 0.10, -R * 0.50); ctx.closePath(); ctx.stroke(); }
      ctx.restore();

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [size, phaseRef, levelRef]);
  return <canvas ref={ref} style={{ width: size, height: size }} />;
}

export default function FridayReactor({ phase, levelRef, size = 300, onTap }: { phase: Phase; levelRef: React.MutableRefObject<number>; size?: number; onTap?: () => void }) {
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  return (
    <button onClick={onTap} className="relative grid place-items-center rounded-full" style={{ width: size, height: size, cursor: onTap ? "pointer" : "default" }} title={onTap ? "Tap to talk" : undefined}>
      <Reactor phaseRef={phaseRef} levelRef={levelRef} size={size} />
      <div className="absolute inset-x-0 bottom-[18%] text-center pointer-events-none">
        <div className="mono text-[11px] tracking-[0.35em]" style={{ color: phaseColor(phase) }}>{phaseLabel(phase)}</div>
      </div>
    </button>
  );
}
