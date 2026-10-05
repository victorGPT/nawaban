import { t as tr, useLocale } from "@/i18n";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { dependencyWire } from "@/lib/modules-model";
import type { ModuleTask, ModulesResponse } from "@/lib/types";

export function DependencyGraph({
  cols,
  deps,
  focusSet,
  card,
}: {
  cols: ModuleTask[][];
  deps: ModulesResponse["deps"];
  focusSet: Set<string> | null;
  card: (t: ModuleTask) => ReactNode;
}) {
  const locale = useLocale();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState({ w: 0, h: 0, normal: "", hot: "" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const onResize = () => setTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Draw edges only when both endpoints are inside the graph wrapper.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const pos = new Map<string, DOMRect>();
    wrap.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
      pos.set(el.dataset.cardId!, el.getBoundingClientRect());
    });
    let normal = "";
    let hot = "";
    for (const [s, d] of deps) {
      const ra = pos.get(d); // Upstream
      const rb = pos.get(s); // Downstream
      if (!ra || !rb) continue;
      const seg = dependencyWire(ra, rb, {
        left: wr.left, top: wr.top,
        scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop,
      });
      if (focusSet && focusSet.has(s) && focusSet.has(d)) hot += seg;
      else normal += seg;
    }
    setWires({ w: wrap.scrollWidth, h: wrap.scrollHeight, normal, hot });
  }, [deps, cols, focusSet, tick, locale]);

  return (
    <div className="relative overflow-x-auto pb-2" ref={wrapRef}>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-visible"
        height={wires.h}
        width={wires.w}
      >
        {wires.normal && (
          <path
            d={wires.normal}
            fill="none"
            opacity={focusSet ? 0.18 : 1}
            stroke="var(--color-text-tertiary)"
            strokeWidth={1.2}
          />
        )}
        {wires.hot && (
          <path
            d={wires.hot}
            fill="none"
            stroke="var(--color-accent-500)"
            strokeWidth={1.8}
          />
        )}
      </svg>
      {cols.length > 0 ? (
        <div className="relative flex w-max items-start gap-11">
          {cols.map((col, i) => (
            <div className="w-[250px] shrink-0" key={i}>
              <div className="flex h-7 items-center px-1 text-body-medium text-text-secondary">
                {tr("stage", { stage: i + 1 })}
                {i === 0
                  ? tr("upstreamSuffix")
                  : i === cols.length - 1
                    ? tr("downstreamSuffix")
                    : ""}
              </div>
              <div className="flex flex-col gap-2 py-1">
                {col.map(card)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-8 text-body-regular text-text-secondary">
          {tr("noChain")}
        </p>
      )}
    </div>
  );
}
