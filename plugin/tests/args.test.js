import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.js";

test("default open mode is 'window'", () => {
  const args = parseArgs([]);
  assert.equal(args.open, "window");
});

test("--open tab selects legacy tab mode", () => {
  const args = parseArgs(["--open", "tab"]);
  assert.equal(args.open, "tab");
});

test("-o window is accepted", () => {
  const args = parseArgs(["-o", "window"]);
  assert.equal(args.open, "window");
});

test("--open=window form is accepted", () => {
  const args = parseArgs(["--open=window"]);
  assert.equal(args.open, "window");
});

test("invalid --open mode throws", () => {
  assert.throws(() => parseArgs(["--open", "popup"]), /Invalid --open mode/);
});

test("open flag composes with scope/base", () => {
  const args = parseArgs(["uncommitted", "--base", "main", "--open", "tab"]);
  assert.equal(args.scope, "uncommitted");
  assert.equal(args.base, "main");
  assert.equal(args.open, "tab");
});
