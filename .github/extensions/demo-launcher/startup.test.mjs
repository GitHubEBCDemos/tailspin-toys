import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUNTIME_FILES } from "./launch.mjs";
import { STARTUP_INSTANCE, openStartupCanvas, verifyStartupRuntime } from "./startup.mjs";

function startup() {
  const calls = [];
  const declaration = { extensionId: "project:demo-launcher", canvasId: "copilot-demos" };
  const state = {
    context: { kind: "demo" }, activeId: "demo",
    environments: [{ id: "demo", repo: "GitHubEBCDemos/startup-test", sessions: [] }],
  };
  const session = {
    sessionId: "first-session",
    rpc: { canvas: {
      list: async () => ({ canvases: [declaration] }),
      listOpen: async () => ({ openCanvases: [] }),
      open: async (input) => { calls.push(input); return input; },
    } },
  };
  const options = {
    controller: { state: async () => state }, session, directory: "/unused",
    verify: async () => { calls.push("verify"); return true; },
  };
  return { calls, declaration, state, session, options };
}

test("verified initial demo startup opens its registered canvas without an agent prompt", async () => {
  const h = startup();
  await openStartupCanvas(h.options);
  assert.deepEqual(h.calls, ["verify", {
    extensionId: "project:demo-launcher", canvasId: "copilot-demos", instanceId: STARTUP_INSTANCE, input: {},
  }]);
  const extension = await readFile(new URL("extension.mjs", import.meta.url), "utf8");
  assert.ok(extension.indexOf("session = await joinSession(") < extension.indexOf("await openStartupCanvas("));
  assert.match(extension, /session\.log\(`Demo canvas automatic startup failed:[\s\S]*level: "error"/);
});

test("already-open project canvas is reused, but another provider's canvas is not adopted", async () => {
  const h = startup();
  const existing = { ...h.declaration, instanceId: "existing-demo-panel" };
  h.session.rpc.canvas.listOpen = async () => ({ openCanvases: [existing] });
  assert.equal(await openStartupCanvas(h.options), existing);
  assert.deepEqual(h.calls, ["verify"]);
  h.session.rpc.canvas.listOpen = async () => ({ openCanvases: [{ ...existing, extensionId: "user:other" }] });
  await openStartupCanvas(h.options);
  assert.equal(h.calls.length, 3);
});

for (const scenario of ["source", "unrecognized", "cleanup", "item session", "item branch"]) {
  test(`automatic canvas startup skips ${scenario}`, async () => {
    const h = startup();
    if (["source", "unrecognized"].includes(scenario)) h.state.context.kind = scenario;
    if (scenario === "cleanup") h.state.environments[0].cleanup = {};
    if (scenario === "item session") h.state.environments[0].sessions = [{ runtimeId: "primary-session" }];
    if (scenario === "item branch") h.options.verify = async () => false;
    await openStartupCanvas(h.options);
    assert.deepEqual(h.calls, []);
  });
}

test("registered primary sessions may reopen their canvas", async () => {
  const h = startup();
  h.state.environments[0].sessions = [{ runtimeId: h.session.sessionId }];
  await openStartupCanvas(h.options);
  assert.equal(h.calls.length, 2);
});

for (const failure of ["verification", "missing provider", "open"]) {
  test(`automatic startup surfaces ${failure} errors rather than claiming success`, async () => {
    const h = startup();
    if (failure === "verification") h.options.verify = async () => { throw new Error("Runtime mismatch"); };
    if (failure === "missing provider") h.session.rpc.canvas.list = async () => ({ canvases: [] });
    if (failure === "open") h.session.rpc.canvas.open = async () => { throw new Error("Renderer unavailable"); };
    await assert.rejects(openStartupCanvas(h.options), /Runtime mismatch|not registered|Renderer unavailable/);
    assert.equal(h.calls.some((call) => typeof call === "object"), false);
  });
}

async function worktree(t) {
  const directory = await mkdtemp(join(tmpdir(), "demo-startup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args) => (await promisify(execFile)("git", ["-C", directory, ...args])).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await git("remote", "add", "origin", "https://github.com/GitHubEBCDemos/startup-test.git");
  const runtime = join(directory, ".github/extensions/demo-launcher");
  await mkdir(runtime, { recursive: true });
  for (const file of RUNTIME_FILES) await copyFile(new URL(file, import.meta.url), join(runtime, file));
  await git("add", ".github");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Fixture runtime");
  const commit = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/remotes/origin/main", commit);
  return {
    directory, runtime, git,
    environment: { repo: "GitHubEBCDemos/startup-test", defaultBranch: "main", launcherReady: true, launcherVerifiedCommit: commit },
  };
}

test("startup checks the pinned runtime read-only in the actual worktree", async (t) => {
  const h = await worktree(t);
  assert.equal(await verifyStartupRuntime(h.directory, h.environment), true);
  assert.equal(await h.git("status", "--porcelain"), "");
});

for (const failure of ["origin", "unverified", "edited file", "missing file", "tracked deletion", "symlink"]) {
  test(`startup rejects ${failure} before opening a canvas`, async (t) => {
    const h = await worktree(t);
    const file = join(h.runtime, "startup.mjs");
    if (failure === "origin") h.environment.repo = "GitHubEBCDemos/another-demo";
    if (failure === "unverified") h.environment.launcherReady = false;
    if (failure === "edited file") await writeFile(file, "Changed runtime");
    if (failure === "missing file") await unlink(file);
    if (failure === "tracked deletion") await h.git("rm", "--cached", "--quiet", "--", ".github/extensions/demo-launcher/startup.mjs");
    if (failure === "symlink") {
      await unlink(file);
      await symlink(join(h.runtime, "index.html"), file);
    }
    await assert.rejects(verifyStartupRuntime(h.directory, h.environment), /origin|verified|mismatch|ENOENT|regular file/);
  });
}

test("an item branch with a different head is not automatically opened", async (t) => {
  const h = await worktree(t);
  await h.git("checkout", "--quiet", "-b", "demo/item");
  await writeFile(join(h.directory, "item.txt"), "Isolated item work");
  await h.git("add", "item.txt");
  await h.git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Item work");
  assert.equal(await verifyStartupRuntime(h.directory, h.environment), false);
});
