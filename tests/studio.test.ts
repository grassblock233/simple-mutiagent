import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLayout, fitLayout, readLayout } from "../lib/studio/layout";
import { buildFileTree, scopeState } from "../lib/studio/file-tree";

test("saved layouts tolerate corrupt, missing and incorrectly typed preferences", () => {
  for (const raw of [null, "{", "null", "[]", '"bad"']) {
    assert.deepEqual(readLayout(raw), defaultLayout);
  }
  assert.deepEqual(
    readLayout(
      JSON.stringify({
        leftOpen: false,
        rightOpen: "false",
        leftWidth: "420",
        expanded: true,
      }),
    ),
    {
      ...defaultLayout,
      leftOpen: false,
      expanded: true,
    },
  );
  const bounded = readLayout(
    '{"leftWidth":99999,"rightWidth":-1,"resultHeight":1e999}',
  );
  assert.equal(bounded.leftWidth, 420);
  assert.equal(bounded.rightWidth, 240);
  assert.equal(bounded.resultHeight, 260);
});

test("shrinking a maximized layout preserves a usable center without mutating preferences", () => {
  const saved = {
    ...defaultLayout,
    leftWidth: 420,
    rightWidth: 480,
    resultHeight: 440,
  };
  const fitted = fitLayout(saved, 1100, 680);
  assert.ok(1100 - 48 - 10 - fitted.leftWidth - fitted.rightWidth >= 400);
  assert.ok(fitted.leftWidth >= 220 && fitted.rightWidth >= 240);
  assert.ok(fitted.resultHeight + 140 + 5 + 70 + 160 <= 680);
  assert.deepEqual(fitLayout(saved, 1920, 1080), saved);
  assert.equal(saved.leftWidth, 420);
  assert.equal(
    fitLayout({ ...saved, rightOpen: false }, 1100, 680).leftWidth,
    420,
  );
});

test("file tree deduplicates paths and groups directories before sibling files", () => {
  const tree = buildFileTree([
    "z.ts",
    "src/nested/a.ts",
    "src/b.ts",
    "src/b.ts",
    "a.ts",
  ]);
  assert.deepEqual(
    tree.map((entry) => entry.name),
    ["src", "a.ts", "z.ts"],
  );
  assert.deepEqual(
    tree[0].children.map((entry) => entry.path),
    ["src/nested", "src/b.ts"],
  );
  assert.equal(tree[0].children[0].children[0].path, "src/nested/a.ts");
  assert.equal(tree[0].directory, true);
  assert.equal(tree[1].directory, false);
  assert.deepEqual(buildFileTree([]), []);
});

test("directory grants cover descendants but never sibling path prefixes", () => {
  const selection = [{ path: "src", directory: true }];
  for (const entry of [
    { path: "src/lib", directory: true },
    { path: "src/lib/a.ts", directory: false },
  ]) {
    assert.deepEqual(scopeState(entry, selection), {
      checked: true,
      inherited: true,
      partial: false,
    });
  }
  assert.equal(
    scopeState({ path: "src2/a.ts", directory: false }, selection).checked,
    false,
  );
  assert.deepEqual(scopeState({ path: "src", directory: true }, selection), {
    checked: true,
    inherited: false,
    partial: false,
  });
  assert.deepEqual(
    scopeState({ path: "src", directory: true }, [
      { path: "src/a.ts", directory: false },
    ]),
    { checked: false, inherited: false, partial: true },
  );
  assert.equal(
    scopeState({ path: "src", directory: true }, [
      { path: "src/a.ts", directory: true },
    ]).checked,
    false,
  );
});
