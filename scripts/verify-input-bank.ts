import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import ts from "typescript";

const repository = fileURLToPath(new URL("../..", import.meta.url));

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat().sort();
}

/** Fail on missing, extra or byte-different files, then enforce the admin boundary. */
export async function verifyInputBank() {
  const source = resolve(repository, "app/src/components/ui/inputs");
  const copy = resolve(repository, "admin/src/components/ui/inputs");
  const [sourceFiles, copyFiles] = await Promise.all([
    files(source),
    files(copy),
  ]);
  assert.deepEqual(
    copyFiles.map((file) => relative(copy, file)),
    sourceFiles.map((file) => relative(source, file)),
    "Admin bank must contain exactly the canonical app bank files.",
  );
  await Promise.all(
    sourceFiles.map(async (file) => {
      const name = relative(source, file);
      const [original, mirrored] = await Promise.all([
        readFile(file),
        readFile(resolve(copy, name)),
      ]);
      assert.ok(original.equals(mirrored), `Input bank differs: ${name}`);
    }),
  );

  const adminFiles = await files(resolve(repository, "admin/src"));
  for (const file of adminFiles.filter((file) => file.endsWith(".tsx"))) {
    if (file.startsWith(copy)) continue;
    const text = await readFile(file, "utf8");
    const name = relative(repository, file);
    assert.ok(
      !/input-(bg|border|text|ring|accent)|bg-input\b|border-border bg-input|rounded-lg border border-border/.test(
        text,
      ),
      `Field chrome outside the bank: ${name}`,
    );
    assert.ok(
      !/@\/components\/ui\/(input|select|checkbox|switch|textarea|number-input|date-input|multi-select|searchable-select|email-tags-input)["']/.test(
        text,
      ),
      `Legacy input import: ${name}`,
    );
    const tree = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node: ts.Node) {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName.getText(tree);
        if (["input", "select", "textarea"].includes(tag)) {
          const hidden =
            tag === "input" &&
            node.attributes.properties.some(
              (attribute) =>
                ts.isJsxAttribute(attribute) &&
                attribute.name.getText(tree) === "type" &&
                attribute.initializer &&
                ts.isStringLiteral(attribute.initializer) &&
                attribute.initializer.text === "hidden",
            );
          assert.ok(hidden, `Raw ${tag} outside the bank: ${name}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  console.log(
    `Input bank: ${sourceFiles.length} byte-identical files; admin boundaries passed.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  verifyInputBank().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
