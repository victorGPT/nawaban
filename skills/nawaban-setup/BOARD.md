<!-- Historical Markdown workflow reference; current tasks use nawaban DB. -->
# Task board

> Reads task frontmatter live, so this view changes whenever a task file changes. It is the only human-facing view.
> Change status in the task file itself; the task holds the truth. The ready-for-acceptance column is split by waiting_on: only the red "Waiting on decision" tag is waiting on you; the others wait on something else.
> Usage: open the repository's .foreman/ directory as an Obsidian vault (needs the Dataview plugin) and put this file at the vault root.

```dataviewjs
const cols = [
  { k: "staging-verified", t: "Ready for acceptance", ico: "⏰", c: "#c0392b" },
  { k: "in_progress",      t: "In progress", ico: "🔵", c: "#3b82f6" },
  { k: "claimed",          t: "Assigned", ico: "📌", c: "#d19a00" },
  { k: "open",             t: "Unassigned", ico: "📥", c: "#8a8a8a" },
];
const ps = dv.pages('"tasks"').where(p => p.file.path.includes("/active/") && p.status && p.status !== "done");

const wrap = dv.el("div", "");
wrap.style.cssText = "display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin:4px 0";

for (const col of cols) {
  const wOrd = p => (p.status === "staging-verified" && String(p.waiting_on ?? "decision") !== "decision") ? 1 : 0;
  const items = [...ps.where(p => p.status === col.k)]
    .sort((a, b) => wOrd(a) - wOrd(b) || String(a.file.name).localeCompare(String(b.file.name), undefined, { numeric: true }));
  const colEl = wrap.createEl("div");
  colEl.style.cssText = "flex:1;min-width:190px";

  const h = colEl.createEl("div");
  h.style.cssText = `font-weight:700;font-size:.82em;notify-spacing:.02em;color:${col.c};border-bottom:2px solid ${col.c};padding-bottom:6px;margin-bottom:10px`;
  h.innerHTML = `${col.ico} ${col.t} <span style="color:var(--text-faint);font-weight:400">${items.length}</span>`;

  if (!items.length) {
    colEl.createEl("div", { text: "—" }).style.cssText = "color:var(--text-faint);font-size:.8em;padding:4px 2px";
  }
  for (const p of items) {
    const card = colEl.createEl("div");
    card.style.cssText = `background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-left:3px solid ${col.c};border-radius:8px;padding:9px 11px;margin-bottom:9px`;
    const a = card.createEl("a", { text: p.file.name, href: p.file.name });
    a.className = "internal-link";
    a.setAttribute("data-href", p.file.name);
    a.style.cssText = "font-weight:600;font-size:.88em;text-decoration:none;line-height:1.3";
    const meta = card.createEl("div");
    meta.style.cssText = "font-size:.74em;color:var(--text-muted);margin-top:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap";
    if (p.epic) {
      const tag = meta.createEl("span", { text: String(p.epic) });
      tag.style.cssText = `background:${col.c}18;color:${col.c};border-radius:4px;padding:0 5px;font-weight:600`;
    }
    if (p.status === "staging-verified") {
      const w = String(p.waiting_on ?? "decision");
      const wt = meta.createEl("span", { text: w === "decision" ? "Waiting on decision" : w });
      wt.style.cssText = w === "decision"
        ? "background:#c0392b;color:#fff;border-radius:4px;padding:0 5px;font-weight:600"
        : "background:var(--background-modifier-border);color:var(--text-muted);border-radius:4px;padding:0 5px";
    }
    meta.createEl("span", { text: p.owner ?? "—" });
  }
}
```

### ✅ Recently done

```dataview
LIST
FROM "tasks"
WHERE contains(file.folder, "done")
SORT file.mtime DESC
LIMIT 12
```
