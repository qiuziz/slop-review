#!/usr/bin/env node
// slop-review — browser-based local HTML review server for AI coding agents.
// Adapted from pi-diff-review (https://github.com/badlogic/pi-diff-review) by Mario Zechner.
//
// Usage:
//   slop-review [scope] [--base <ref>]
//
// Scopes:
//   base          (default) all changes since the merge-base with the base branch
//                 (auto-detected: origin/HEAD → origin/main → main → origin/master → master)
//                 — includes both commits since base AND uncommitted changes
//   last-commit   only HEAD vs HEAD^
//   uncommitted   only working-tree changes vs HEAD
//   all           include the "all files" scope as the initial tab (debug)
//
// Flags:
//   --base <ref>  override the base branch (only used in `base` mode)
//   --help, -h    show this help
//
// On submit: writes the composed feedback to $TMPDIR/slop-review-<ts>.md and prints
//            "FEEDBACK_FILE: <path>" to stdout.
// On cancel / browser tab closed via Cancel button / SIGINT: prints "REVIEW_CANCELLED" to stdout.
// On error: prints message to stderr and exits 1.
//
// Window behavior:
//   --open window (default): opens a tiny "launcher" helper tab that script-opens the
//       review window via window.open(). Because that review window is script-opened,
//       clicking Finish/Cancel truly closes it (window.close() is honored).
//   --open tab: opens the review page directly (legacy). On Finish/Cancel the tab can't
//       be script-closed by the browser, so a "you may close this tab" overlay is shown.

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { INITIAL_TAB, parseArgs } from "../src/args.js";
import {
  getRepoRoot,
  getReviewWindowData,
  loadReviewFileContents,
  resolveBaseRef,
  resolveMergeBase,
} from "../src/git.js";
import { composeReviewPrompt } from "../src/prompt.js";
import { buildReviewHtml } from "../src/ui.js";

const HELP = `slop-review — open a local HTML review server in your browser for AI coding agents.

Usage:
  slop-review [scope] [--base <ref>] [--help]

Scopes (positional or --scope <name>):
  base          (default) all changes since merge-base with base branch
  last-commit   HEAD vs HEAD^
  uncommitted   working tree vs HEAD
  all           initial tab = "all files" (mostly for debugging)

Options:
  --base <ref>  override base branch (default: auto-detect origin/HEAD,
                origin/main, main, origin/master, master)
  --open <mode> how to open the review: "window" (default) opens a launcher tab that
                script-opens a closeable review window; "tab" opens the review page
                directly (legacy; shows a close overlay on finish instead of closing).
  -h, --help    show this help and exit
`;

function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

function openBrowser(url) {
  let cmd, args;
  if (process.platform === "darwin") {
    cmd = "open"; args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd"; args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open"; args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* 浏览器唤起失败不影响服务本身 */
  }
}

/**
 * Minimal self-contained "launcher" page. The CLI opens this tab via the OS
 * `open` command (so it can't be script-closed), and this page in turn opens the
 * real review window via window.open() on a user click. Because the review window
 * is script-opened, the browser allows it to close itself on Finish/Cancel.
 */
function buildLauncherHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>slop-review</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #c9d1d9;
  }
  @media (prefers-color-scheme: light) {
    body { background: #ffffff; color: #1f2328; }
  }
  .card {
    max-width: 440px; padding: 28px 32px; border-radius: 12px; text-align: center;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
    box-shadow: 0 8px 30px rgba(0,0,0,0.3);
  }
  @media (prefers-color-scheme: light) {
    .card { background: #f6f8fa; border-color: #d0d7de; box-shadow: 0 8px 30px rgba(0,0,0,0.08); }
  }
  h1 { font-size: 18px; margin: 0 0 8px; }
  #msg { font-size: 14px; line-height: 1.5; opacity: 0.9; margin: 0 0 16px; }
  button {
    font-size: 14px; padding: 10px 18px; border-radius: 8px; border: 0; cursor: pointer;
    background: #238636; color: #fff; font-weight: 600;
  }
  button:hover { background: #2ea043; }
  .hint { margin-top: 14px; font-size: 12px; opacity: 0.6; }
  .done { color: #3fb950; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <h1>slop-review</h1>
    <p id="msg">Opening the review window…</p>
    <button id="openBtn" style="display:none">Open review window</button>
    <div class="hint" id="hint">The review window is opened by a script so it can close itself when you finish.</div>
  </div>
<script>
  (function () {
    var reviewUrl = location.origin + "/";
    var msg = document.getElementById("msg");
    var btn = document.getElementById("openBtn");
    var hint = document.getElementById("hint");
    function openReview() {
      var w = window.open(reviewUrl, "slopReview");
      if (!w) return false;
      msg.textContent = "Review window opened.";
      btn.style.display = "none";
      hint.textContent = "When you finish the review, that window closes itself. You may close this tab afterwards.";
      var t = setInterval(function () {
        if (w.closed) {
          clearInterval(t);
          msg.innerHTML = '<span class="done">Review complete.</span>';
          hint.textContent = "You may close this tab now.";
        }
      }, 500);
      return true;
    }
    btn.addEventListener("click", openReview);
    // Auto-attempt on load; popup blockers require a user gesture, so fall back to the button.
    if (!openReview()) {
      msg.textContent = "Your browser blocked the automatic popup.";
      btn.style.display = "inline-block";
      hint.textContent = "Click the button below to open the review window.";
    }
  })();
</script>
</body>
</html>`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

async function resolveScopeContext(repoRoot, args) {
  // Returns { gitDiffOriginalRef, scopeLabels, scopeHints, baseRefName, baseRefShort }
  if (args.scope !== "base") {
    return { gitDiffOriginalRef: "HEAD", scopeLabels: null, scopeHints: null, baseRefName: null };
  }

  const baseRefName = await resolveBaseRef(repoRoot, args.base);
  if (!baseRefName) {
    log(args.base
      ? `Base ref "${args.base}" not found; falling back to "uncommitted" scope.`
      : `Could not auto-detect a base branch (origin/HEAD, origin/main, main, origin/master, master); falling back to "uncommitted" scope.`);
    return { gitDiffOriginalRef: "HEAD", scopeLabels: null, scopeHints: null, baseRefName: null };
  }

  const mergeBase = await resolveMergeBase(repoRoot, baseRefName);
  if (!mergeBase) {
    log(`No merge-base between HEAD and ${baseRefName}; falling back to "uncommitted" scope.`);
    return { gitDiffOriginalRef: "HEAD", scopeLabels: null, scopeHints: null, baseRefName: null };
  }

  log(`Comparing against base ref ${baseRefName} (merge-base ${mergeBase.slice(0, 8)}).`);
  return {
    gitDiffOriginalRef: mergeBase,
    scopeLabels: { "git-diff": `vs ${baseRefName}` },
    scopeHints: {
      "git-diff": `Review all changes since the merge-base with ${baseRefName} (committed and uncommitted). Hover or click line numbers in the gutter to add an inline comment.`,
    },
    baseRefName,
    mergeBase,
  };
}

/**
 * 启动本地 diff 评审 HTTP 服务（取代 Glimpse 原生窗口）。
 * @returns {{ server: import("node:http").Server, url: string, resultPromise: Promise<object> }}
 */
export async function startReviewServer({ html, files, repoRoot, gitDiffOriginalRef, loadFileContents }) {
  const fileMap = new Map(files.map((f) => [f.id, f]));
  const contentCache = new Map();
  const load = (file, scope) => {
    const key = `${scope}:${file.id}`;
    if (contentCache.has(key)) return contentCache.get(key);
    const pending = loadFileContents(repoRoot, file, scope, { gitDiffOriginalRef });
    contentCache.set(key, pending);
    return pending;
  };

  let settleResult;
  let settled = false;
  const resultPromise = new Promise((resolve) => { settleResult = resolve; });
  const finish = (value) => {
    if (settled) return;
    settled = true;
    settleResult(value);
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "GET" && req.url === "/launcher") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(buildLauncherHtml());
        return;
      }
      if (req.method === "POST" && req.url === "/api/file") {
        const body = await readJsonBody(req);
        const file = fileMap.get(body.fileId);
        if (file == null) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            type: "file-error", requestId: body.requestId, fileId: body.fileId,
            scope: body.scope, message: "Unknown file requested.",
          }));
          return;
        }
        try {
          const contents = await load(file, body.scope);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            type: "file-data", requestId: body.requestId, fileId: body.fileId,
            scope: body.scope,
            originalContent: contents.originalContent,
            modifiedContent: contents.modifiedContent,
          }));
        } catch (err) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            type: "file-error", requestId: body.requestId, fileId: body.fileId,
            scope: body.scope, message: err instanceof Error ? err.message : String(err),
          }));
        }
        return;
      }
      if (req.method === "POST" && req.url === "/api/submit") {
        const body = await readJsonBody(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        finish(body);
        return;
      }
      if (req.method === "POST" && req.url === "/api/cancel") {
        await readJsonBody(req).catch(() => ({}));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        finish({ type: "cancel" });
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/`, resultPromise };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n\n${HELP}`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const cwd = process.cwd();
  const repoRoot = await getRepoRoot(cwd);
  const ctx = await resolveScopeContext(repoRoot, args);

  const { files } = await getReviewWindowData(cwd, { gitDiffOriginalRef: ctx.gitDiffOriginalRef });
  if (files.length === 0) {
    log("No reviewable files found for the requested scope.");
    process.stdout.write("REVIEW_CANCELLED\n");
    return;
  }

  const initialScope = INITIAL_TAB[args.scope];
  const html = buildReviewHtml({
    repoRoot,
    files,
    initialScope,
    scopeLabels: ctx.scopeLabels,
    scopeHints: ctx.scopeHints,
    baseRefName: ctx.baseRefName ?? null,
  });

  const { server, url, resultPromise } = await startReviewServer({
    html,
    files,
    repoRoot,
    gitDiffOriginalRef: ctx.gitDiffOriginalRef,
    loadFileContents: loadReviewFileContents,
  });

  // --open window (default): open the launcher tab, which script-opens a closeable
  //   review window. --open tab: open the review page directly (legacy overlay fallback).
  const launchUrl = args.open === "tab" ? url : `${url}launcher`;
  openBrowser(launchUrl);
  log(`Opened review (mode: ${args.open}) at ${url} (${files.length} files, scope: ${args.scope}${ctx.baseRefName ? `, base: ${ctx.baseRefName}` : ""}).`);

  let settled = false;
  const terminalMessage = await new Promise((resolve) => {
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    resultPromise.then(settle);
    process.once("SIGINT", () => {
      try { server.close(); } catch {}
      settle({ type: "cancel" });
    });
  });

  try { server.close(); } catch {}

  if (terminalMessage == null || terminalMessage.type === "cancel") {
    log("Review cancelled.");
    process.stdout.write("REVIEW_CANCELLED\n");
    return;
  }

  const prompt = composeReviewPrompt(files, terminalMessage);
  const outPath = join(tmpdir(), `slop-review-${Date.now()}.md`);
  await writeFile(outPath, prompt + "\n", "utf8");
  process.stdout.write(`FEEDBACK_FILE: ${outPath}\n`);
  log(`Wrote feedback to ${outPath}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`slop-review failed: ${message}\n`);
    process.exit(1);
  });
}
