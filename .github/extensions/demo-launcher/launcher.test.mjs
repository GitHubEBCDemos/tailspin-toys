import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Controller, FEATURE_PROMPT, Store } from "./controller.mjs";
import { BRANCH, DEMO_OWNER, FIXTURE, FIXTURE_PATH, GitHubError, RULE, TEMPLATE, provision, pullRequestBody } from "./github.mjs";
import { startServer } from "./server.mjs";
import { harness } from "./test-support.mjs";

test("creates unique repository names with no name or approval input", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await h.create();
  const { environments } = await h.store.read();
  assert.equal(environments.length, 2);
  assert.notEqual(environments[0].name, environments[1].name);
  for (const environment of environments) {
    assert.match(environment.name, /^tailspin-demo-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);
    assert.equal(environment.repo, `${DEMO_OWNER}/${environment.name}`);
    assert.equal(environment.createdBy, "presenter");
  }
});

test("creates an internal environment without public exposure, configures CodeQL before PR, and never merges canvas setup", async (t) => {
  const h = await harness(t);
  h.remote.initializationDelays = 2;
  const created = await h.create();
  const environment = await h.current();
  assert.equal(environment.githubReady, true);
  assert.equal(environment.repo, `${DEMO_OWNER}/${environment.name}`);
  assert.equal(environment.prNumber, 1);
  assert.equal(environment.sessionId, undefined);
  assert.equal(environment.visibility, "internal");
  assert.equal(h.remote.repository.visibility, "internal");
  assert.equal(h.remote.repository.private, true);
  assert.equal(h.remote.fixture, Buffer.from(FIXTURE).toString("base64"));
  const writes = h.calls.filter((call) => call.method !== "GET");
  assert.deepEqual(writes.slice(0, 6).map((call) => call.method), ["POST", "PATCH", "PATCH", "POST", "PUT", "POST"]);
  assert.equal(writes.filter((call) => call.path.endsWith("/pulls")).length, 3);
  assert.equal(writes.filter((call) => call.path.endsWith("/issues")).length, 1);
  assert.ok(writes.every((call) => !call.body?.branch || call.body.branch.startsWith("demo/")));
  assert.equal(writes[0].path, `repos/${TEMPLATE}/generate`);
  assert.equal(writes[0].body.owner, DEMO_OWNER);
  assert.equal(writes[0].body.private, true);
  assert.equal(writes[1].path, `repos/${environment.repo}`);
  assert.deepEqual(writes[1].body, { visibility: "internal" });
  assert.equal(writes[2].path, `repos/${environment.repo}/code-scanning/default-setup`);
  assert.equal(writes[3].body.ref, `refs/heads/${BRANCH}`);
  assert.equal(writes[4].body.branch, BRANCH);
  assert.ok(writes[5].body.body.includes("never merge or deploy"));
  assert.equal(h.messages.length, 0);
  assert.equal(environment.launcherReady, true);
  assert.equal(environment.launcherVerifiedCommit, h.remote.mainSha);
  assert.equal(writes.filter(({ path }) => path.endsWith("/merges")).length, 0);
  assert.match(created.environments[0].launchUrl, /^https:\/\/github.com\/copilot\/app\/launch/);
  assert.deepEqual((await h.source.state()).environments, []);
  assert.doesNotMatch(FIXTURE, /\.listen\s*\(/);
  assert.match(FIXTURE, /searchParams\.get/);
});

for (const status of [403, 422]) {
  test(`internal visibility HTTP ${status} stops creation before CodeQL, fixtures, or launch`, async (t) => {
    const h = await harness(t);
    h.remote.failure = (method, _path, body) => method === "PATCH" && body?.visibility === "internal"
      ? new GitHubError(`Internal visibility unavailable (${status})`, status) : null;
    await assert.rejects(h.create(), /Internal visibility unavailable/);
    const environment = await h.current();
    assert.equal(environment.visibility, "internal");
    assert.equal(environment.repositoryId, h.remote.repository.id);
    assert.equal(h.remote.repository.visibility, "private");
    assert.equal(h.remote.repository.private, true);
    assert.equal(environment.githubReady, false);
    assert.equal(environment.launcherReady, undefined);
    assert.match(environment.error, /Internal visibility unavailable/);
    assert.equal(h.calls.some(({ path }) => path.includes("/code-scanning/")), false);
    assert.equal(h.remote.pulls.length, 0);
    assert.deepEqual(h.calls.filter(({ method }) => method !== "GET").map(({ body }) => body.private ?? body.visibility), [true, "internal"]);
  });
}

for (const visibility of ["private", "public", undefined]) {
  test(`unconfirmed internal visibility (${visibility}) cannot satisfy provisioning`, async (t) => {
    const h = await harness(t);
    h.source.api = async (method, path, body) => {
      const result = await h.api(method, path, body);
      if (method === "PATCH" && body?.visibility === "internal") {
        h.remote.repository.visibility = visibility;
        h.remote.repository.private = visibility !== "public";
      }
      return result;
    };
    await assert.rejects(h.create(), /visibility must be internal/);
    assert.equal(h.calls.some(({ path }) => path.includes("/code-scanning/")), false);
    assert.equal((await h.current()).launcherReady, undefined);
    assert.equal(h.remote.pulls.length, 0);
  });
}

test("a lost visibility response is recoverable without recreating the repository or repeating the visibility update", async (t) => {
  const h = await harness(t);
  h.source.api = async (method, path, body) => {
    const result = await h.api(method, path, body);
    if (method === "PATCH" && body?.visibility === "internal") throw new Error("Lost visibility response");
    return result;
  };
  await assert.rejects(h.create(), /Lost visibility response/);
  const environment = await h.current();
  assert.equal(environment.repositoryId, h.remote.repository.id);
  assert.equal(h.remote.repository.visibility, "internal");
  await provision(environment, { api: h.api, save: async () => {} });
  assert.equal(environment.githubReady, true);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 1);
  assert.equal(h.calls.filter(({ body }) => body?.visibility === "internal").length, 1);
});

test("legacy public demo receipts remain usable without changing their visibility", async (t) => {
  const h = await harness(t);
  await h.create();
  const state = await h.store.read();
  delete state.environments[0].visibility;
  h.remote.repository.visibility = "public";
  h.remote.repository.private = false;
  await h.store.write(state);
  const updates = h.calls.filter(({ body }) => body?.visibility).length;
  await h.link();
  await h.controller.refresh();
  assert.equal(h.remote.repository.visibility, "public");
  assert.equal(h.calls.filter(({ body }) => body?.visibility).length, updates);
});

test("refuses to adopt another repo and preserves a recoverable receipt", async (t) => {
  const h = await harness(t);
  h.controller.api = async (method, path, body) => {
    if (method === "GET" && new RegExp(`^repos/${DEMO_OWNER}/tailspin-demo-[^/]+$`).test(path)) {
      return { full_name: path.slice("repos/".length), id: 999, description: "Someone else's project" };
    }
    return h.api(method, path, body);
  };
  await assert.rejects(h.create(), /identity/);
  assert.equal(h.calls.filter((call) => call.method !== "GET").length, 0);
  assert.match((await h.current()).error, /identity/);
  assert.equal(h.messages.length, 0);
});

test("Create starts a new repository after a lost response and retains the failed attempt's receipt", async (t) => {
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
  const failed = await h.current();
  await h.create();
  assert.equal((await h.current()).githubReady, true);
  assert.notEqual((await h.current()).repo, failed.repo);
  assert.match((await h.store.read()).environments[0].error, /Connection lost/);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/generate")).length, 2);
});

test("failed CodeQL setup does not become the next Create target", async (t) => {
  const h = await harness(t);
  h.remote.failure = (method, path) => method === "PATCH" && path.endsWith("default-setup") ? new GitHubError("Forbidden: enable code scanning", 403) : null;
  await assert.rejects(h.create(), /Forbidden/);
  assert.equal(h.remote.pulls.length, 0);
  assert.match((await h.current()).error, /Forbidden/);
  h.remote.failure = null;
  await h.create();
  assert.equal(h.remote.pulls.length, 3);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/generate")).length, 2);
  assert.equal((await h.store.read()).environments.length, 2);
  assert.equal(h.messages.length, 0);
});

test("Create stays in the organization when the signed-in account changes", async (t) => {
  const h = await harness(t);
  h.remote.failure = (method) => method === "PATCH" ? new GitHubError("Forbidden", 403) : null;
  await assert.rejects(h.create(), /Forbidden/);
  const failed = await h.current();
  h.remote.failure = null;
  h.source.api = (method, path, body) => path === "user" ? { login: "another-presenter" } : h.api(method, path, body);
  await h.create();
  assert.equal((await h.current()).owner, DEMO_OWNER);
  assert.equal((await h.current()).createdBy, "another-presenter");
  assert.deepEqual((await h.store.read()).environments[0], failed);
  assert.equal((await h.store.read()).environments.length, 2);
});

test("organization creation failure never falls back to a personal repository", async (t) => {
  const h = await harness(t);
  h.remote.failure = (method, path) => method === "POST" && path.endsWith("/generate")
    ? new GitHubError("Organization repository creation is forbidden", 403) : null;
  await assert.rejects(h.create(), /Organization repository creation is forbidden/);
  const creations = h.calls.filter(({ path }) => path.endsWith("/generate"));
  assert.equal(creations.length, 1);
  assert.equal(creations[0].body.owner, DEMO_OWNER);
  assert.equal((await h.current()).owner, DEMO_OWNER);
  assert.equal((await h.current()).launcherReady, undefined);
});

test("Create ignores legacy pending setup and never changes that old receipt", async (t) => {
  const h = await harness(t);
  await h.create();
  const state = await h.store.read();
  delete state.environments[0].sourceSessionId;
  state.environments[0].request = { kind: "session", status: "pending" };
  await h.store.write(state);
  await h.create();
  assert.deepEqual((await h.store.read()).environments[0], state.environments[0]);
  assert.equal((await h.current()).sourceSessionId, "source-session");
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 2);
  await h.create();
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 3);
});

test("Create starts fresh after a lost PR response; changed fixtures and closed PRs remain protected", async (t) => {
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
  await h.create();
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
  await assert.rejects(h.create(), /validation ended with failure/);
  assert.equal((await h.current()).setupFailed, true);
  h.remote.setupRun = { status: "completed", conclusion: "success" };
  await h.create();
  assert.equal(h.remote.pulls.length, 3);
  assert.equal(h.calls.filter(({ method, path }) => method === "PATCH" && path.endsWith("/code-scanning/default-setup")).length, 3);
});

test("CodeQL setup retries a newly created run's 404 and waits for successful validation", async (t) => {
  const h = await harness(t);
  h.remote.setupRun = { status: "in_progress", conclusion: null };
  let missingReads = 2;
  h.remote.failure = (method, path) => method === "GET" && path.endsWith("/actions/runs/42") && missingReads-- > 0
    ? new GitHubError("Not Found", 404) : null;
  let waits = 0;
  h.source.sleep = async (ms) => {
    assert.equal(ms, 5_000);
    assert.equal(h.remote.branch, null);
    assert.equal(h.remote.pulls.length, 0);
    const environment = (await h.source.state()).environments[0];
    assert.equal(environment.githubReady, false);
    assert.equal(environment.launchUrl, null);
    if (++waits === 3) h.remote.setupRun = { status: "completed", conclusion: "success" };
  };
  const created = await h.create();
  assert.equal(waits, 3);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/actions/runs/42")).length, 4);
  assert.equal(h.calls.filter(({ method, path }) => method === "PATCH" && path.endsWith("/code-scanning/default-setup")).length, 1);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 1);
  assert.equal((await h.store.read()).environments.length, 1);
  assert.equal((await h.current()).setupRunPath, null);
  assert.equal((await h.current()).launcherReady, true);
  assert.ok(created.environments[0].launchUrl);
});

test("a persistently missing CodeQL setup run times out without seeding or launching", async (t) => {
  const h = await harness(t);
  h.remote.setupRun = { status: "completed", conclusion: "success" };
  h.remote.failure = (method, path) => method === "GET" && path.endsWith("/actions/runs/42")
    ? new GitHubError("Not Found", 404) : null;
  let waits = 0;
  h.source.sleep = async (ms) => { assert.equal(ms, 5_000); waits += 1; };
  await assert.rejects(h.create(), /CodeQL setup validation is not ready yet/);
  assert.equal(waits, 24);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/actions/runs/42")).length, 24);
  assert.equal(h.calls.filter(({ method, path }) => method === "PATCH" && path.endsWith("/code-scanning/default-setup")).length, 1);
  assert.equal(h.remote.branch, null);
  assert.equal(h.remote.pulls.length, 0);
  const environment = await h.current();
  assert.equal(environment.setupRunPath, `repos/${environment.repo}/actions/runs/42`);
  assert.equal(environment.githubReady, false);
  assert.equal(environment.launcherReady, undefined);
  assert.match(environment.error, /CodeQL setup validation is not ready yet/);
  assert.deepEqual((await h.source.state()).environments, []);
});

for (const status of [401, 403, 429, 500]) {
  test(`CodeQL setup run HTTP ${status} is not treated as a publication delay`, async (t) => {
    const h = await harness(t);
    h.remote.setupRun = { status: "completed", conclusion: "success" };
    h.remote.failure = (method, path) => method === "GET" && path.endsWith("/actions/runs/42")
      ? new GitHubError(`Setup run HTTP ${status}`, status) : null;
    h.source.sleep = async () => { assert.fail("Unexpected retry"); };
    await assert.rejects(h.create(), new RegExp(`Setup run HTTP ${status}`));
    assert.equal(h.calls.filter(({ path }) => path.endsWith("/actions/runs/42")).length, 1);
    assert.equal(h.remote.branch, null);
    assert.equal(h.remote.pulls.length, 0);
    assert.equal((await h.current()).launcherReady, undefined);
  });
}

test("CodeQL configuration lookup 404 is not treated as a setup-run publication delay", async (t) => {
  const h = await harness(t);
  h.remote.failure = (method, path) => method === "GET" && path.endsWith("/code-scanning/default-setup")
    ? new GitHubError("Code scanning unavailable", 404) : null;
  h.source.sleep = async () => { assert.fail("Unexpected retry"); };
  await assert.rejects(h.create(), /Code scanning unavailable/);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/code-scanning/default-setup")).length, 1);
  assert.equal(h.remote.branch, null);
});

for (const delays of [2, 24]) {
  test(`CodeQL language readback ${delays === 2 ? "waits for the validated configuration" : "times out without seeding"}`, async (t) => {
    const h = await harness(t);
    h.remote.setupRun = { status: "completed", conclusion: "success" };
    let remaining = delays;
    h.source.api = async (method, path, body) => {
      const result = await h.api(method, path, body);
      if (method === "GET" && path.endsWith("/code-scanning/default-setup") && result.state === "configured" && remaining-- > 0) {
        return { ...result, languages: [] };
      }
      return result;
    };
    let waits = 0;
    h.source.sleep = async (ms) => {
      assert.equal(ms, 5_000);
      assert.equal(h.remote.branch, null);
      assert.equal(h.remote.pulls.length, 0);
      waits += 1;
    };
    if (delays === 24) {
      await assert.rejects(h.create(), /CodeQL JavaScript\/TypeScript default setup is not ready yet/);
      assert.equal((await h.current()).launcherReady, undefined);
    } else {
      await h.create();
      assert.equal((await h.current()).launcherReady, true);
    }
    assert.equal(waits, delays);
    assert.equal(h.calls.filter(({ method, path }) => method === "PATCH" && path.endsWith("/code-scanning/default-setup")).length, 1);
    assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 1);
  });
}

test("CodeQL waits for template language indexing and records a failed attempt on timeout", async (t) => {
  const h = await harness(t);
  h.remote.languageDelays = 24;
  await assert.rejects(h.create(), /GitHub language detection is not ready/);
  assert.equal(h.remote.pulls.length, 0);
  assert.match((await h.current()).step, /Waiting for GitHub language detection/);
  h.remote.languageDelays = 2;
  await h.create();
  assert.equal((await h.current()).launcherReady, true);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 2);
  assert.equal(h.calls.filter(({ method, path }) => method === "PATCH" && path.endsWith("/code-scanning/default-setup")).length, 27);
});

test("unrelated CodeQL validation errors are not retried as language-indexing delays", async (t) => {
  const h = await harness(t);
  h.remote.failure = (method, path) => method === "PATCH" && path.endsWith("/code-scanning/default-setup") ? new GitHubError("Invalid runner configuration", 422) : null;
  await assert.rejects(h.create(), /Invalid runner configuration/);
  assert.equal(h.calls.filter(({ method, path }) => method === "PATCH" && path.endsWith("/code-scanning/default-setup")).length, 1);
});

test("seeded PR preserves template headings, comments and checklist items", async () => {
  const template = await readFile(new URL("../../PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8");
  const body = await pullRequestBody({ id: "test-environment" });
  const structure = (text) => text.split("\n").filter((line) => /^(#+ |<!--|- \[)/.test(line));
  assert.deepEqual(structure(body), structure(template));
  assert.match(body, /not run by environment provisioning/);
});

test("feature work runs in the bound demo session, never the core session or a self-message", async (t) => {
  const h = await harness(t);
  await h.create();
  await assert.rejects(h.controller.feature(), /Open the new repository/);
  await h.link();
  await h.controller.feature();
  assert.match(h.messages[0].prompt, /get_session on "demo-session"/);
  assert.match(h.messages[0].prompt, /project "demo-project"/);
  assert.ok(h.messages[0].prompt.includes(FEATURE_PROMPT));
  assert.match(h.messages[0].prompt, /directly in this verified demo session/);
  assert.doesNotMatch(h.messages[0].prompt, /send_session_message with/);
  await assert.rejects(h.controller.feature(), /pending/);
  assert.equal(h.messages.length, 1);
});

test("session binding checks repo and IDs; receipts reject stale requests", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await assert.rejects(h.controller.receipt({
    environmentId: (await h.current()).id, requestId: "old-request", kind: "feature", status: "done",
  }), /Stale/);
  const environment = await h.current();
  await assert.rejects(h.controller.bindSession({
    repo: environment.repo, projectId: "demo-project", sessionId: 'bad"session', sessionName: "Bad",
  }), /Verified app/);
  await assert.rejects(h.controller.bindSession({
    repo: TEMPLATE, projectId: "demo-project", sessionId: "demo-session", sessionName: "Bad",
  }), /repository does not match/);
  assert.equal((await h.current()).sessions[0].id, "demo-session");
});

test("receipts survive new controllers and malformed files are not silently reset", async (t) => {
  const h = await harness(t);
  await h.create();
  const reloaded = new Controller({ store: new Store(h.store.directory), api: h.api, repo: TEMPLATE, sessionId: () => "source-session", send: async () => assert.fail("Must not resend on reload") });
  assert.deepEqual(await reloaded.state(), await h.controller.state());
  assert.equal((await reloaded.store.read()).environments.length, 1);
  assert.deepEqual((await reloaded.state()).environments, []);
  await writeFile(h.store.path, "{broken");
  await assert.rejects(reloaded.state(), SyntaxError);
});

test("failed app receipt never claims successful delivery", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await h.controller.feature();
  const environment = await h.current();
  await h.controller.receipt({
    environmentId: environment.id, requestId: environment.request.id, kind: "feature", status: "failed",
  });
  assert.match((await h.current()).error, /could not complete/);
  assert.equal((await h.current()).request.status, "failed");
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
  await h.link();
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
  await h.link();
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
  const idle = await (await fetch(`${second.url}state`)).json();
  assert.equal(idle.activeId, null);
  assert.deepEqual(idle.environments, []);
});
