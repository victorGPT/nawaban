import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

/** Every TS/JS source under `directory`, tests excluded. */
function sources(directory: URL, out: URL[] = []): URL[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.[jt]sx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(path);
  }
  return out;
}

test("NAWABAN surfaces compose the shadcn kit rather than recreating native controls or importing another kit", () => {
  const root = new URL("../", import.meta.url);
  // Every app-layer file, however deep. components/ui is the generated kit;
  // components/application predates this rule and still holds a native <a> and <button>.
  const exempt = ["components/ui/", "components/application/"];
  const files = sources(root).map(path => path.pathname.split("/src/")[1])
    .filter(file => file === "App.tsx" || file === "main.tsx" || /^(views|components)\//.test(file))
    .filter(file => !exempt.some(directory => file.startsWith(directory)));
  const controls = new Set(["button", "input", "textarea", "select", "a", "dialog", "progress", "table"]);
  const violations: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      // `render={<a … />}` is the Base UI / shadcn way to pick a component's
      // rendered element; that element is a render target, not a hand-rolled
      // control, so the native-element rule stops at the attribute.
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "render") return;
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && controls.has(node.tagName.getText(source))) {
        violations.push(`${file}: native ${node.tagName.getText(source)}`);
      }
      if (ts.isImportDeclaration(node) && /components\/kibo-ui\/|radix|sonner|lucide/.test(node.moduleSpecifier.getText(source))) {
        violations.push(`${file}: non-kit control import`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(violations, []);
});


test("installed components and dependencies use one interaction foundation", () => {
  const root = new URL("../", import.meta.url);
  const violations: string[] = [];
  for (const path of sources(root)) {
    const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && /react-aria|@react-stately/.test(statement.moduleSpecifier.getText(source))) violations.push(path.pathname);
    }
  }
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", root), "utf8"));
  violations.push(...Object.keys(lock.packages).filter(path => /node_modules\/(react-aria|@react-aria|@react-stately)/.test(path)));
  assert.deepEqual(violations, []);
});

/**
 * components/ui is the only place Base UI is addressed directly: everything
 * else composes the generated shadcn components. The hand-built kit it
 * replaced (components/base, components/foundations) must stay deleted.
 */
test("only components/ui speaks Base UI, and the old hand-built kit is gone", () => {
  const root = new URL("../", import.meta.url);
  const violations: string[] = [];
  for (const dead of ["components/base", "components/foundations"]) {
    if (existsSync(new URL(dead, root))) violations.push(`${dead}/ is back; it was replaced by components/ui`);
  }
  for (const path of sources(root)) {
    if (path.pathname.includes("/components/ui/")) continue;
    const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      // Re-exports (`export … from`) count too, or a barrel file could leak Base UI.
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier) continue;
      const specifier = statement.moduleSpecifier.getText(source).slice(1, -1);
      if (/^@base-ui\/react/.test(specifier)) {
        violations.push(`${path.pathname.split("/src/")[1]}: imports ${specifier} outside components/ui`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

/**
 * Feature folders (components/<name>/) are presentational: the view that
 * assembles them does the fetching. Top-level components/*.tsx are not held
 * to this yet.
 */
test("feature component folders neither fetch through lib/api nor reach into views", () => {
  const root = new URL("../", import.meta.url);
  const violations: string[] = [];
  for (const path of sources(root)) {
    const file = path.pathname.split("/src/")[1];
    if (!/^components\/[^/]+\//.test(file) || /^components\/(ui|application)\//.test(file)) continue;
    const source = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier) continue;
      const specifier = statement.moduleSpecifier.getText(source).slice(1, -1);
      // Resolve `@/…` and relative specifiers to one src-relative spelling.
      const target = specifier.startsWith("@/") ? specifier.slice(2)
        : specifier.startsWith(".") ? new URL(specifier, path).pathname.split("/src/")[1] ?? "" : "";
      if (/^lib\/api(\.ts)?$|^views(\/|$)/.test(target)) violations.push(`${file}: imports ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});
