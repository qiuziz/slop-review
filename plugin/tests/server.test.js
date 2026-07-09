import { test } from "node:test";
import assert from "node:assert/strict";
import { startReviewServer } from "../bin/slop-review.js";

const files = [
  {
    id: "a.js::working::::",
    path: "a.js",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    gitDiff: { status: "modified", oldPath: "a.js", newPath: "a.js", displayPath: "a.js", hasOriginal: true, hasModified: true },
    lastCommit: null,
  },
];

const fakeLoad = async (_repoRoot, _file, scope) =>
  scope === "all-files"
    ? { originalContent: "WT", modifiedContent: "WT" }
    : { originalContent: "ORIG", modifiedContent: "MOD" };

function start() {
  return startReviewServer({ html: "<!doctype html><html>review</html>", files, repoRoot: "/tmp", gitDiffOriginalRef: "HEAD", loadFileContents: fakeLoad });
}

test("GET / returns the inlined html", async () => {
  const { server, url } = await start();
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /review/);
  } finally { server.close(); }
});

test("POST /api/file returns file-data for known file", async () => {
  const { server, url } = await start();
  try {
    const res = await fetch(`${url}api/file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r1", fileId: files[0].id, scope: "git-diff" }),
    });
    const body = await res.json();
    assert.equal(body.type, "file-data");
    assert.equal(body.originalContent, "ORIG");
    assert.equal(body.modifiedContent, "MOD");
  } finally { server.close(); }
});

test("POST /api/file returns file-error for unknown file", async () => {
  const { server, url } = await start();
  try {
    const res = await fetch(`${url}api/file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r2", fileId: "nope", scope: "git-diff" }),
    });
    const body = await res.json();
    assert.equal(body.type, "file-error");
  } finally { server.close(); }
});

test("POST /api/submit resolves the result promise", async () => {
  const { server, url, resultPromise } = await start();
  try {
    const payload = { type: "submit", overallComment: "ok", comments: [] };
    const res = await fetch(`${url}api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    assert.equal((await resultPromise).type, "submit");
  } finally { server.close(); }
});

test("POST /api/cancel resolves with cancel", async () => {
  const { server, url, resultPromise } = await start();
  try {
    await fetch(`${url}api/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "cancel" }),
    });
    assert.equal((await resultPromise).type, "cancel");
  } finally { server.close(); }
});
