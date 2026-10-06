import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import ts from "typescript";
import { harness } from "./test-support.mjs";
import { CI_BRANCH, CI_PATH, CI_SOURCE, CI_TEST, CI_TEST_PATH, REVIEW_BRANCH, REVIEW_PATH, REVIEW_SOURCE, provisionScenarios } from "./scenarios.mjs";

async function finishHandoff(h, kind) {
  const environment = await h.current();
  await h.controller.receipt({ environmentId: environment.id, requestId: environment.request.id, kind, status: "done" });
}

test("all scenarios are isolated, recoverable, and do not request reviews or agent work during provisioning", async (t) => {
  const h = await harness(t);
  await h.create();
  const environment = await h.current();
  assert.equal(environment.scenariosReady, true);
  assert.equal(h.remote.issues.length, 1);
  assert.equal(h.remote.pulls.length, 3);
  assert.equal(h.remote.reviewRequests.length, 0);
  assert.equal(h.messages.length, 1);
  for (const branch of [REVIEW_BRANCH, CI_BRANCH]) assert.equal(h.remote.branches.get(branch).object.sha, "base-sha");
  assert.equal(Buffer.from(h.remote.files.get(`${REVIEW_BRANCH}:${REVIEW_PATH}`), "base64").toString(), REVIEW_SOURCE);
  assert.equal(Buffer.from(h.remote.files.get(`${CI_BRANCH}:${CI_PATH}`), "base64").toString(), CI_SOURCE);
  const writes = h.calls.filter(({ method }) => method !== "GET").length;
  await provisionScenarios(environment, { api: h.api, save: async () => {} });
  assert.equal(h.calls.filter(({ method }) => method !== "GET").length, writes);
  assert.ok(!h.calls.some(({ method, path }) => method !== "GET" && path.includes("/.github/workflows/")));
});

for (const resource of ["issue", "review", "ci"]) {
  test(`lost ${resource} creation response is recovered without duplicating the resource`, async (t) => {
    const h = await harness(t);
    const api = h.controller.api;
    h.controller.api = async (method, path, body) => {
      const result = await api(method, path, body);
      if (method === "POST" && (resource === "issue" ? path.endsWith("/issues") : path.endsWith("/pulls") && body.head === (resource === "review" ? REVIEW_BRANCH : CI_BRANCH))) {
        h.controller.api = api;
        throw new Error("Lost creation response");
      }
      return result;
    };
    await assert.rejects(h.create(), /Lost creation response/);
    await h.controller.resume();
    assert.equal(h.remote.issues.length, 1);
    assert.equal(h.remote.pulls.length, 3);
    assert.equal((await h.current()).scenariosReady, true);
  });
}

test("resuming an older environment adds scenarios without recreating the security PR or resetting edited fixtures", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  const state = await h.store.read();
  delete state.environments[0].scenarios;
  delete state.environments[0].scenariosReady;
  await h.store.write(state);
  h.remote.fixture = Buffer.from("security fix already applied").toString("base64");
  h.remote.files.set(`${REVIEW_BRANCH}:${REVIEW_PATH}`, Buffer.from("review fix already applied").toString("base64"));
  const writes = h.calls.filter(({ method }) => method !== "GET").length;
  await h.controller.resume();
  assert.equal(h.calls.filter(({ method }) => method !== "GET").length, writes);
  assert.equal(h.remote.pulls.length, 3);
  assert.equal(h.messages.length, 1);
});

test("issue-to-PR routes to an isolated issue session with explicit PR authorization", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await h.controller.scenario({ kind: "issue" });
  const environment = await h.current();
  const prompt = h.messages[1].prompt;
  assert.ok(prompt.includes(`issue_number=${environment.scenarios.issue.number}`));
  assert.match(prompt, /open_issue_session/);
  assert.match(prompt, /create_pull_request/);
  assert.match(prompt, /Do not use the feature demo session/);
  assert.match(prompt, /Never commit to the default branch or merge/);
  await assert.rejects(h.controller.scenario({ kind: "issue" }), /pending/);
  await finishHandoff(h, "issue");
  assert.equal((await h.current()).request.status, "done");
  h.remote.issues[0].state = "closed";
  await assert.rejects(h.controller.scenario({ kind: "issue" }), /issue is closed/);
  assert.equal(h.messages.length, 2);
});

test("code review requests are scoped, deduplicated, and report completion only for the current PR commit", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await h.controller.scenario({ kind: "review" });
  await h.controller.scenario({ kind: "review" });
  const environment = await h.current();
  const pull = h.remote.pulls.find(({ number }) => number === environment.scenarios.review.number);
  assert.deepEqual(h.remote.reviewRequests, [{ repo: environment.repo, number: pull.number }]);
  assert.equal(h.messages.length, 1);
  assert.equal((await h.current()).scenarios.review.status.state, "requested");
  h.remote.reviewUsers = [];
  h.remote.reviews = [{ user: { login: "copilot-pull-request-reviewer[bot]", type: "Bot" }, commit_id: "old", submitted_at: "2026-10-06" }];
  await h.controller.refreshScenario({ kind: "review" });
  assert.equal((await h.current()).scenarios.review.status.state, "requested");
  h.remote.reviews[0].commit_id = pull.head.sha;
  await h.controller.refreshScenario({ kind: "review" });
  assert.equal((await h.current()).scenarios.review.status.state, "reviewed");
  pull.head.ref = "main";
  await assert.rejects(h.controller.scenario({ kind: "review" }), /no longer matches/);
});

test("review policy errors are surfaced and do not count as a requested review", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  h.controller.requestReview = async () => { throw new Error("Copilot review is not enabled for this account"); };
  await assert.rejects(h.controller.scenario({ kind: "review" }), /not enabled/);
  const environment = await h.current();
  assert.equal(environment.scenarios.review.requestedHead, undefined);
  assert.match(environment.error, /not enabled/);
});

test("CI repair requires a fresh failed unit-test step and uses the existing PR in its own session", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await assert.rejects(h.controller.scenario({ kind: "ci" }), /Waiting/);
  const environment = await h.current();
  const pull = h.remote.pulls.find(({ number }) => number === environment.scenarios.ci.number);
  h.remote.ciRuns = [{ id: 51, head_sha: "old", status: "completed", conclusion: "failure" }];
  await assert.rejects(h.controller.scenario({ kind: "ci" }), /Waiting/);
  h.remote.ciRuns[0].head_sha = pull.head.sha;
  h.remote.ciJobs = [{ name: "unit-tests", steps: [{ name: "Install JavaScript dependencies", conclusion: "failure" }] }];
  await assert.rejects(h.controller.scenario({ kind: "ci" }), /expected unit-test step/);
  h.remote.ciJobs[0].steps = [{ name: "Run unit tests", conclusion: "failure" }];
  await h.controller.scenario({ kind: "ci" });
  const prompt = h.messages[1].prompt;
  assert.match(prompt, /open_pr_session/);
  assert.ok(prompt.includes(`pr_number=${pull.number}`));
  assert.ok(prompt.includes(`https://github.com/${environment.repo}/actions/runs/51`));
  assert.match(prompt, /do not create another PR/);
  assert.match(prompt, /Do not skip, delete, weaken/);
  await finishHandoff(h, "ci");
  h.remote.ciRuns[0].conclusion = "success";
  await h.controller.refreshScenario({ kind: "ci" });
  assert.equal((await h.current()).scenarios.ci.status.state, "passed");
  await assert.rejects(h.controller.scenario({ kind: "ci" }), /checks are green/);
  h.remote.failure = (_method, path) => path.includes("run-tests.yml/runs") ? new Error("Actions access denied") : null;
  await assert.rejects(h.controller.refreshScenario({ kind: "ci" }), /denied/);
  assert.equal((await h.current()).scenarios.ci.status.state, "unavailable");
});

test("demo fixture types and lint pass; the seeded Vitest failures turn green with the implementation fix", async (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "tailspin-demo-fixtures-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
  await mkdir(join(temporary, "src/lib"), { recursive: true });
  const fixtures = [[REVIEW_PATH, REVIEW_SOURCE], [CI_PATH, CI_SOURCE], [CI_TEST_PATH, CI_TEST]];
  const lint = new ESLint({ cwd: root });
  for (const [path, source] of fixtures) {
    await writeFile(join(temporary, path), source);
    const results = await lint.lintText(source, { filePath: resolve(root, path) });
    assert.equal(results[0].errorCount, 0, JSON.stringify(results[0].messages));
  }
  const program = ts.createProgram(fixtures.map(([path]) => join(temporary, path)), {
    noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")), []);
  const report = join(temporary, "report.json");
  const run = () => spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", temporary, "--reporter=json", "--outputFile", report], {
    cwd: temporary, encoding: "utf8", timeout: 60_000,
  });
  const failed = run();
  assert.equal(failed.status, 1, failed.stderr);
  const failures = JSON.parse(await readFile(report, "utf8"));
  assert.equal(failures.numFailedTests, 2);
  assert.equal(failures.numPassedTests, 3);
  assert.deepEqual(failures.testResults[0].assertionResults.filter(({ status }) => status === "failed").map(({ title }) => title), [
    "counts pages for 21 games with a page size of 10", "counts pages for 1 games with a page size of 10",
  ]);
  await writeFile(join(temporary, CI_PATH), CI_SOURCE.replace("Math.floor", "Math.ceil"));
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(await readFile(report, "utf8")).numPassedTests, 5);
  const compiled = ts.transpileModule(REVIEW_SOURCE, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { pageOf } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const items = ["A", "B", "C", "D"];
  assert.deepEqual(pageOf(items, 1, 2), ["C", "D"]);
  assert.deepEqual(items, ["A", "B", "C", "D"]);
});
