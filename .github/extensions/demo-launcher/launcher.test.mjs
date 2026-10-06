import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Controller, FEATURE_PROMPT, Store } from "./controller.mjs";
import { BRANCH, FIXTURE, FIXTURE_PATH, GitHubError, RULE, TEMPLATE, provision, pullRequestBody } from "./github.mjs";
import { startServer } from "./server.mjs";
import { harness } from "./test-support.mjs";

test("creates unique repository names with no name or approval input", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await h.create();
  const { environments } = await h.controller.state();
  assert.equal(environments.length, 2);
  assert.notEqual(environments[0].name, environments[1].name);
  for (const environment of environments) {
    assert.match(environment.name, /^tailspin-demo-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
    assert.equal(environment.repo, `presenter/${environment.name}`);
  }
});

test("creates isolated public environment, configures CodeQL before PR, never writes main", async (t) => {
  const h = await harness(t);
  h.remote.initializationDelays = 2;
  await h.create();
  const environment = await h.current();
  assert.equal(environment.githubReady, true);
  assert.equal(environment.repo, `presenter/${environment.name}`);
  assert.equal(environment.prNumber, 1);
  assert.equal(environment.sessionId, undefined);
  assert.equal(h.remote.repository.private, false);
  assert.equal(h.remote.fixture, Buffer.from(FIXTURE).toString("base64"));
  const writes = h.calls.filter((call) => call.method !== "GET");
  assert.deepEqual(writes.slice(0, 5).map((call) => call.method), ["POST", "PATCH", "POST", "PUT", "POST"]);
  assert.equal(writes.filter((call) => call.path.endsWith("/pulls")).length, 3);
  assert.equal(writes.filter((call) => call.path.endsWith("/issues")).length, 1);
  assert.ok(writes.every((call) => !call.body?.branch || call.body.branch.startsWith("demo/")));
  assert.equal(writes[0].path, `repos/${TEMPLATE}/generate`);
  assert.equal(writes[2].body.ref, `refs/heads/${BRANCH}`);
  assert.equal(writes[3].body.branch, BRANCH);
  assert.ok(writes[4].body.body.includes("never merge or deploy"));
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].prompt, /create_project[\s\S]*create_session/);
  assert.ok(h.messages[0].prompt.includes(environment.repo));
  assert.doesNotMatch(FIXTURE, /\.listen\s*\(/);
  assert.match(FIXTURE, /searchParams\.get/);
});

test("refuses to adopt another repo and preserves a recoverable receipt", async (t) => {
  const h = await harness(t);
  h.controller.api = async (method, path, body) => {
    if (method === "GET" && /^repos\/presenter\/tailspin-demo-[^/]+$/.test(path)) {
      return { full_name: path.slice("repos/".length), id: 999, description: "Someone else's project" };
    }
    return h.api(method, path, body);
  };
  await assert.rejects(h.create(), /identity/);
  assert.equal(h.calls.filter((call) => call.method !== "GET").length, 0);
  assert.match((await h.current()).error, /identity/);
  assert.equal(h.messages.length, 0);
});

test("resumes a lost create response using the UUID marker without creating a duplicate repo", async (t) => {
  const h = await harness(t);
  const api = h.controller.api;
  h.controller.api = async (method, path, body) => {
    const result = await api(method, path, body);
    if (path.endsWith("/generate")) {
      h.controller.api = api;
      throw new Error("Connection lost after creation");
    }
    return result;
  };
  await assert.rejects(h.create(), /Connection lost/);
  await h.controller.resume();
  assert.equal((await h.current()).githubReady, true);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/generate")).length, 1);
});

test("partial CodeQL permission failure remains visible and retry does not duplicate resources", async (t) => {
  const h = await harness(t);
  h.remote.failure = (method, path) => method === "PATCH" && path.endsWith("default-setup") ? new GitHubError("Forbidden: enable code scanning", 403) : null;
  await assert.rejects(h.create(), /Forbidden/);
  assert.equal(h.remote.pulls.length, 0);
  assert.match((await h.current()).error, /Forbidden/);
  h.remote.failure = null;
  await h.controller.resume();
  await h.controller.resume();
  assert.equal(h.remote.pulls.length, 3);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/generate")).length, 1);
  assert.equal(h.messages.length, 1);
});

test("lost PR response is recovered and changed fixtures or closed PRs are not overwritten", async (t) => {
  const h = await harness(t);
  const api = h.controller.api;
  h.controller.api = async (method, path, body) => {
    const result = await api(method, path, body);
    if (method === "POST" && path.endsWith("/pulls")) {
      h.controller.api = api;
      throw new Error("Lost PR response");
    }
    return result;
  };
  await assert.rejects(h.create(), /Lost PR response/);
  await h.controller.resume();
  assert.equal(h.remote.pulls.length, 3);
  const environment = await h.current();
  h.remote.fixture = Buffer.from("edited").toString("base64");
  await assert.rejects(provision(environment, { api, save: async () => {} }), /Refusing to overwrite/);
  h.remote.fixture = Buffer.from(FIXTURE).toString("base64");
  h.remote.pulls[0].state = "closed";
  await assert.rejects(provision(environment, { api, save: async () => {} }), /was closed/);
});

test("CodeQL setup validation must succeed before creating a security branch or PR", async (t) => {
  const h = await harness(t);
  h.remote.setupRun = { status: "in_progress", conclusion: null };
  await assert.rejects(h.create(), /CodeQL setup validation is not ready/);
  assert.equal(h.remote.pulls.length, 0);
  assert.equal(h.remote.branch, null);
  const environment = await h.current();
  assert.equal(environment.setupRunPath, `repos/${environment.repo}/actions/runs/42`);
  h.remote.setupRun = { status: "completed", conclusion: "failure" };
  await assert.rejects(h.controller.resume(), /validation ended with failure/);
  assert.equal((await h.current()).setupFailed, true);
  h.remote.setupRun = { status: "completed", conclusion: "success" };
  await h.controller.resume();
  assert.equal(h.remote.pulls.length, 3);
  assert.equal(h.calls.filter((call) => call.method === "PATCH").length, 2);
});

test("seeded PR preserves template headings, comments and checklist items", async () => {
  const template = await readFile(new URL("../../PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8");
  const body = await pullRequestBody({ id: "test-environment" });
  const structure = (text) => text.split("\n").filter((line) => /^(#+ |<!--|- \[)/.test(line));
  assert.deepEqual(structure(body), structure(template));
  assert.match(body, /not run by environment provisioning/);
});

test("handoffs route to the recorded session, not this checkout; duplicate pending clicks rejected", async (t) => {
  const h = await harness(t);
  await h.create();
  await assert.rejects(h.controller.feature(), /linked/);
  await h.link();
  await h.controller.feature();
  assert.match(h.messages[1].prompt, /session_id="demo-session"/);
  assert.match(h.messages[1].prompt, /project "demo-project"/);
  assert.ok(h.messages[1].prompt.includes(FEATURE_PROMPT));
  assert.match(h.messages[1].prompt, /Never implement the feature in the launcher/);
  await assert.rejects(h.controller.feature(), /pending/);
  assert.equal(h.messages.length, 2);
});

test("session recovery rejects stale receipts and validates IDs", async (t) => {
  const h = await harness(t);
  await h.create();
  const old = await h.current();
  await h.controller.retrySession({ confirmRetry: true });
  await assert.rejects(h.controller.receipt({
    environmentId: old.id, requestId: old.request.id, kind: "session", status: "done",
    projectId: "demo-project", sessionId: "demo-session",
  }), /Stale/);
  const environment = await h.current();
  await assert.rejects(h.controller.receipt({
    environmentId: environment.id, requestId: environment.request.id, kind: "session", status: "done",
    projectId: "demo-project", sessionId: 'bad"session',
  }), /verified app/);
  await h.link();
  assert.equal((await h.current()).sessionId, "demo-session");
});

test("receipts survive new controllers and malformed files are not silently reset", async (t) => {
  const h = await harness(t);
  await h.create();
  const reloaded = new Controller({ store: new Store(h.store.directory), api: h.api, send: async () => assert.fail("Must not resend on reload") });
  assert.deepEqual(await reloaded.state(), await h.controller.state());
  await reloaded.resume();
  await writeFile(h.store.path, "{broken");
  await assert.rejects(reloaded.state(), SyntaxError);
});

test("failed app receipt never claims successful delivery", async (t) => {
  const h = await harness(t);
  await h.create();
  const environment = await h.current();
  await h.controller.receipt({
    environmentId: environment.id, requestId: environment.request.id, kind: "session", status: "failed",
  });
  assert.match((await h.current()).error, /could not complete/);
  assert.equal((await h.current()).sessionId, undefined);
});

test("concurrent operations are rejected and a dead-process lock can be recovered", async (t) => {
  const h = await harness(t);
  await h.store.exclusive(async () => {
    await assert.rejects(h.store.exclusive(async () => {}), /Another launcher operation/);
  });
  // This PID is outside the macOS/Linux PID range; process.kill(..., 0) is read-only.
  await writeFile(h.store.lockPath, "2147483647");
  await h.store.exclusive(async () => {});
  await assert.rejects(readFile(h.store.lockPath), { code: "ENOENT" });
});

test("readiness distinguishes pending, failed, missing, stale, alert and confirmed PR suggestion", async (t) => {
  const h = await harness(t);
  await h.create();
  const refresh = async () => {
    await h.controller.refresh();
    return (await h.current()).scan.state;
  };
  assert.equal(await refresh(), "pending");
  h.remote.workflow_runs = [{ id: 1, name: "CodeQL", conclusion: "failure" }];
  assert.equal(await refresh(), "failed");
  h.remote.workflow_runs[0].conclusion = "success";
  assert.equal(await refresh(), "missing");
  h.remote.alerts = [{ rule: { id: RULE }, most_recent_instance: { location: { path: "wrong.cjs" }, commit_sha: "merge-sha" } }];
  assert.equal(await refresh(), "missing");
  h.remote.alerts[0].most_recent_instance.location.path = FIXTURE_PATH;
  h.remote.alerts[0].most_recent_instance.commit_sha = "older-sha";
  assert.equal(await refresh(), "stale");
  h.remote.alerts[0].most_recent_instance.commit_sha = "merge-sha";
  assert.equal(await refresh(), "alert");
  h.remote.comments = [{ user: { login: "github-advanced-security[bot]" }, path: FIXTURE_PATH, commit_id: "old-sha", body: "Copilot Autofix\n```suggestion\nfixed\n```" }];
  assert.equal(await refresh(), "alert");
  h.remote.comments[0].commit_id = "head-sha";
  assert.equal(await refresh(), "ready");
  h.remote.pulls[0].state = "closed";
  assert.equal(await refresh(), "closed");
  assert.ok(h.calls.some((call) => call.path.includes("ref=refs%2Fpull%2F1%2Fmerge")));
  assert.ok(!h.calls.some((call) => /alerts\/\d+\/autofix/.test(call.path)));
});

test("readiness permission errors never appear as pending or ready", async (t) => {
  const h = await harness(t);
  await h.create();
  h.remote.failure = (_method, path) => path.includes("/code-scanning/alerts?") ? new GitHubError("Forbidden to read alerts", 403) : null;
  await assert.rejects(h.controller.refresh(), /Forbidden/);
  assert.equal((await h.current()).scan.state, "unavailable");
});

test("loopback serves assets and state, rejects foreign origins and unauthenticated mutation", async (t) => {
  const h = await harness(t);
  const server = await startServer(h.controller);
  t.after(server.close);
  const origin = new URL(server.url).origin;
  assert.equal(new URL(server.url).hostname, "127.0.0.1");
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Show what Copilot can do/);
  assert.ok(page.headers.get("content-security-policy").includes("script-src 'self'"));
  assert.equal((await fetch(`${origin}/state`)).status, 404);
  assert.equal((await fetch(`${server.url}state`, { headers: { Origin: "https://evil.example" } })).status, 403);
  const post = (headers, body = "{}") => fetch(`${server.url}create`, { method: "POST", headers, body });
  assert.equal((await post({ "Content-Type": "application/json" })).status, 403);
  assert.equal((await post({ Origin: origin, "Content-Type": "text/plain" })).status, 403);
  assert.equal((await post({ Origin: origin, "Content-Type": "application/json" }, '"bad"')).status, 400);
  assert.equal((await post({ Origin: origin, "Content-Type": "application/json" }, JSON.stringify({ text: "x".repeat(5000) }))).status, 400);
  assert.equal(h.calls.length, 0);
  const response = await post({ Origin: origin, "Content-Type": "application/json" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).environments[0].prNumber, 1);
  const second = await startServer(h.controller);
  t.after(second.close);
  assert.equal((await (await fetch(`${second.url}state`)).json()).environments[0].prNumber, 1);
});
