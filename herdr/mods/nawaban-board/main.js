// nawaban board, read-only: the tasks of the project the shown space works in, grouped as the web
// board's columns. Data comes from the nawaban CLI (`nawaban json ...`), so no board server is needed.
// The CLI is the checkout docs/install.md puts at ~/nawaban; it runs in the space's folder without
// --db, so it finds the same board an agent working there does.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, focused, exec, theme, home } from "herdr";
import { groupTasks, projectFor, resolveLang, WORDS } from "./logic.js";

const POLL_MS = 5000;
const cli = () => `${home()}/nawaban/nawaban/cli.py`;

// The shown space's folder; home for a remote space (v1 reads this computer's board only).
function folder() {
  const space = spaces().find((s) => s.active);
  if (space?.machine) return home();
  return focused()?.cwd || space?.folder || home();
}

async function nawaban(args, cwd) {
  const r = await exec("python3", [cli(), ...args], { cwd });
  let out = null;
  try { out = JSON.parse(r.stdout || "null"); } catch {}
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || r.stderr?.trim().split("\n").pop() || `exit ${r.code}`);
  return { out, raw: r.stdout };
}

export default class NawabanBoard extends View {
  init(_props, cx) {
    this.groups = null;
    this.error = null;
    this.all = false; // ponytail: "all projects" is not remembered across reloads; the spec only asks for language
    this.projects = new Map(); // folder -> its project (null: none), resolved once per folder
    try { this.lang = localStorage.getItem("lang"); } catch { this.lang = null; }
    if (this.lang !== "zh" && this.lang !== "en") {
      this.lang = "en";
      cx.spawn(async (cx) => {
        let r = await exec("defaults", ["read", "-g", "AppleLanguages"]).catch(() => null);
        if (r?.code !== 0) r = await exec("sh", ["-c", 'printf %s "$LANG"']).catch(() => null);
        this.lang = resolveLang(null, r?.stdout);
        cx.notify();
      });
    }
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    const cwd = folder(), all = this.all;
    this.loading = true;
    this.context = cwd;
    cx.spawn(async (cx) => {
      try {
        if (!this.projects.has(cwd)) {
          const git = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
          const { out } = await nawaban(["json", "projects"], cwd);
          this.projects.set(cwd, projectFor(git.code === 0 ? git.stdout : "", out));
        }
        const project = this.projects.get(cwd);
        const { out, raw } = await nawaban(["json", "board", ...(project && !all ? ["--project", project] : [])], cwd);
        if (this.context !== cwd || this.all !== all) return; // the space or scope changed meanwhile: the next refresh reads it
        this.project = project;
        this.error = null;
        if (raw === this.raw) return;
        this.raw = raw;
        this.groups = groupTasks(out);
      } catch (e) {
        this.error = String(e?.message ?? e); // keep the last list shown
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    if (folder() !== this.context) this.refresh(cx);
    const t = theme(), w = WORDS[this.lang];
    const choice = (id, label, on, click) => div().id(id).px(8).py(2).rounded(6).cursor_pointer().text_size(12)
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { click(cx); cx.notify(); }).child(label);
    const setAll = (all) => (cx) => { if (this.all !== all) { this.all = all; this.raw = null; this.refresh(cx); } };
    const setLang = (lang) => () => { this.lang = lang; try { localStorage.setItem("lang", lang); } catch {} };
    const color = { in_progress: t.working, open: t.foreground, done: t.done };

    const header = h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().pr(6).child("nawaban"))
      .when(Boolean(this.project), (el) => el
        .child(choice("scope-project", this.project, !this.all, setAll(false)))
        .child(choice("scope-all", w.all, this.all, setAll(true))))
      .when(!this.project, (el) => el.child(div().px(8).text_size(12).text_color(t.muted).child(w.all)))
      .child(div().flex_1())
      .child(choice("lang-zh", "中", this.lang === "zh", setLang("zh")))
      .child(div().text_size(12).text_color(t.dim).child("/"))
      .child(choice("lang-en", "EN", this.lang === "en", setLang("en")));

    const row = (task) => h_flex().h(28).flex_none().px(8).gap(8).items_center()
      .child(div().flex_none().text_size(12).text_color(t.muted).child(task.id))
      .child(div().flex_1().min_w(0).truncate().text_color(task.blocked ? t.muted : t.foreground).child(task.title))
      .when(task.blocked, (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(w.blocked)));
    const group = (g) => v_flex().flex_none().pb(8)
      .child(h_flex().h(26).px(8).gap(6).items_center().text_size(12).font_semibold()
        .child(div().text_color(color[g.key]).child(w[g.key]))
        .child(div().text_color(t.dim).child(String(g.tasks.length))))
      .children(g.tasks.map(row));

    const note = this.error ? `${w.error}: ${this.error}` : !this.groups ? w.loading
      : this.groups.every((g) => !g.tasks.length) ? w.empty : null;
    return v_flex().id("nawaban-board").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13)
      .child(header)
      .when(Boolean(note), (el) => el.child(div().px(16).py(8).text_size(12).text_color(this.error ? t.blocked : t.dim).child(note)))
      .child(v_flex().id("nawaban-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).children((this.groups ?? []).map(group)));
  }
}
