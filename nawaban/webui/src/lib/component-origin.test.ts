import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

test("NAWABAN surfaces compose BoardUI rather than recreating native controls or importing another kit", () => {
  const root = new URL("../", import.meta.url);
  const files = ["App.tsx", "main.tsx", ...readdirSync(new URL("components/", root))
    .filter(name => name.endsWith(".tsx")).map(name => `components/${name}`)];
  const controls = new Set(["button", "input", "textarea", "select", "a", "dialog", "progress", "table"]);
  const violations: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && controls.has(node.tagName.getText(source))) {
        violations.push(`${file}: native ${node.tagName.getText(source)}`);
      }
      if (ts.isImportDeclaration(node) && /components\/(ui|kibo-ui)\/|radix|sonner|lucide/.test(node.moduleSpecifier.getText(source))) {
        violations.push(`${file}: non-BoardUI control import`);
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
  function scan(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) scan(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        const source = ts.createSourceFile(entry.name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
        for (const statement of source.statements) {
          if (ts.isImportDeclaration(statement) && /react-aria|@react-stately/.test(statement.moduleSpecifier.getText(source))) violations.push(path.pathname);
        }
      }
    }
  }
  scan(root);
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", root), "utf8"));
  violations.push(...Object.keys(lock.packages).filter(path => /node_modules\/(react-aria|@react-aria|@react-stately)/.test(path)));
  assert.deepEqual(violations, []);
});
