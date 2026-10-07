import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startServer } from "./server.mjs";
import { harness } from "./test-support.mjs";
import { GitHubError } from "./github.mjs";

async function canvas(t, controller) {
  const server = await startServer(controller);
  t.after(server.close);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  // Never launch a real app session or contact GitHub during browser validation.
  await context.route("https://github.com/copilot/app/launch?**", (route) => route.fulfill({ body: "Launch confirmation (test adapter)" }));
  const page = await context.newPage();
  return { page, context, url: server.url };
}

async function finish(h, kind) {
  const environment = await h.current();
  await h.controller.receipt({
    environmentId: environment.id, requestId: environment.request.id, kind, status: "done",
    ...(kind === "feature" ? {} : { projectId: "demo-project", sessionId: `${kind}-session`, sessionName: `${kind} demo` }),
  });
}

function assertRepositorySetup(href, repo) {
  const launcher = new URL(href);
  assert.equal(launcher.origin, "https://github.com");
  assert.equal(launcher.pathname, "/copilot/app/launch");
  assert.equal(launcher.searchParams.get("open"), `ghapp://github.com/${repo}`);
}

test("Create opens repository setup only; the user explicitly starts the pinned demo session afterward", async (t) => {
  const h = await harness(t);
  const { page, context, url } = await canvas(t, h.source);
  await page.goto(url);
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await expect(page.getByTestId("create-environment")).toHaveText("Create");
  await expect(page.getByTestId("demo-org-link")).toHaveAttribute("href", "https://github.com/GitHubEBCDemos");
  await expect(page.getByTestId("template-link")).toHaveAttribute("href", "https://github.com/GitHubEBCDemos/tailspin-toys");
  await expect(page.getByTestId("resume-setup")).toHaveCount(0);
  await expect(page.locator("#demos")).toBeHidden();
  await expect(page.getByTestId("cleanup")).toBeHidden();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  const opened = page.waitForEvent("popup");
  await page.getByTestId("create-environment").click();
  const popup = await opened;
  await expect(popup).toHaveURL(/^https:\/\/github.com\/copilot\/app\/launch\?open=/);
  const first = await h.current();
  assertRepositorySetup(popup.url(), first.repo);
  await expect(page.getByTestId("open-app")).toHaveAttribute("href", popup.url());
  await expect(page.getByTestId("start-demo-session")).toBeVisible();
  await expect(page.locator("#approval-instructions")).toContainText("this launcher cannot read the app's trust state");
  await expect(page.locator("#status")).toContainText("No demo session has been started");
  assert.equal(context.pages().length, 2);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(({ id }) => id), []);
  }
  const sessionOpened = page.waitForEvent("popup");
  await page.getByTestId("start-demo-session").focus();
  await page.keyboard.press("Enter");
  const sessionPopup = await sessionOpened;
  await expect(sessionPopup).toHaveURL(/^https:\/\/github.com\/copilot\/app\/launch\?open=/);
  const href = sessionPopup.url();
  await expect(page.getByTestId("create-environment")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#create-spinner")).toBeHidden();
  const target = new URL(new URL(href).searchParams.get("open"));
  assert.equal(target.searchParams.get("repo"), (await h.current()).repo);
  assert.match(target.searchParams.get("repo"), /^GitHubEBCDemos\/tailspin-demo-/);
  assert.equal(target.searchParams.get("branch"), "main");
  assert.match(target.searchParams.get("prompt"), /Open the Copilot demos canvas/);
  assert.doesNotMatch(target.searchParams.get("prompt"), /extensions_reload|extensions_manage/);
  assert.match(target.searchParams.get("prompt"), /BOOTSTRAP\.md from that commit using git show/);
  assert.ok(target.searchParams.get("prompt").length <= 750);
  assert.equal(h.messages.length, 0);
  await expect(page.locator("#demos")).toBeHidden();
  await expect(page.locator("#environment-info")).toBeVisible();
  await expect(page.getByTestId("open-app")).toBeVisible();
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await popup.close();
  await sessionPopup.close();
  await page.reload();
  await expect(page.locator("#environment-info")).toBeHidden();
  await expect(page.getByTestId("start-demo-session")).toBeHidden();
  const nextPopup = page.waitForEvent("popup");
  await page.getByTestId("create-environment").click();
  const next = await nextPopup;
  await expect(next).toHaveURL(/^https:\/\/github.com\/copilot\/app\/launch\?open=/);
  assertRepositorySetup(next.url(), (await h.current()).repo);
  assert.notEqual((await h.current()).repo, first.repo);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 2);
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await expect(page.locator("#environment-info")).toBeVisible();
  const nextTarget = new URL(new URL(await page.getByTestId("start-demo-session").getAttribute("href")).searchParams.get("open"));
  assert.equal(nextTarget.searchParams.get("repo"), (await h.current()).repo);
  await next.close();
});

test("Create starts fresh after failure, shows current progress, and opens setup for the new repository", async (t) => {
  const h = await harness(t);
  h.remote.failure = (method) => method === "PATCH" ? new GitHubError("Forbidden: enable code scanning", 403) : null;
  const { page, context, url } = await canvas(t, h.source);
  await page.goto(url);
  await page.getByTestId("create-environment").click();
  await expect(page.getByRole("alert")).toContainText("Forbidden");
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await expect(page.getByTestId("create-environment")).toHaveText("Create");
  await expect(page.locator("#create-spinner")).toBeHidden();
  await expect.poll(() => context.pages().length).toBe(1);
  await page.waitForResponse((response) => response.url() === `${url}state`);
  await expect(page.getByRole("alert")).toContainText("Forbidden");
  const repository = (await h.current()).repo;
  await page.reload();
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await expect(page.getByTestId("resume-setup")).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeHidden();
  await page.waitForResponse((response) => response.url() === `${url}state`);
  await expect(page.getByRole("alert")).toBeHidden();
  assert.match((await h.current()).error, /Forbidden/);
  h.remote.failure = null;
  h.remote.setupRun = { status: "in_progress", conclusion: null };
  const gate = Promise.withResolvers();
  h.source.sleep = () => gate.promise;
  const opened = page.waitForEvent("popup");
  try {
    await page.getByTestId("create-environment").click();
    await expect(page.getByTestId("create-environment")).toBeDisabled();
    await expect(page.getByTestId("create-environment")).toHaveText("Creating...");
    await expect(page.getByTestId("create-environment")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#create-spinner")).toBeVisible();
    await expect(page.locator("#create-spinner")).toHaveCSS("animation-name", "spin");
    await expect(page.locator("#setup-status")).toContainText("Waiting for CodeQL setup validation");
    await expect(page.getByRole("alert")).toBeHidden();
    await expect(page.getByTestId("open-app")).toBeHidden();
    await expect(page.getByTestId("start-demo-session")).toBeHidden();
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(({ id }) => id), []);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("#create-spinner")).toHaveCSS("animation-name", "none");
  } finally {
    h.remote.setupRun = { status: "completed", conclusion: "success" };
    gate.resolve();
  }
  const popup = await opened;
  await expect(popup).toHaveURL(/^https:\/\/github.com\/copilot\/app\/launch\?open=/);
  await expect(page.getByTestId("create-environment")).toHaveText("Create");
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await expect(page.locator("#create-spinner")).toBeHidden();
  await expect(page.getByRole("alert")).toBeHidden();
  assert.notEqual((await h.current()).repo, repository);
  assert.equal((await h.source.state()).environments.length, 0);
  assert.equal((await h.store.read()).environments.length, 2);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 2);
  await expect(page.locator("#environment-info")).toBeVisible();
  assertRepositorySetup(popup.url(), (await h.current()).repo);
  await popup.close();
});

test("popup blocking retains working setup and session links, including after a canceled launch", async (t) => {
  const h = await harness(t);
  const { page, url } = await canvas(t, h.source);
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto(url);
  await page.getByTestId("create-environment").click();
  await expect(page.locator("#status")).toContainText("blocked or closed");
  await expect(page.getByTestId("open-app")).toHaveAttribute("href", /^https:\/\/github.com\/copilot\/app\/launch\?open=/);
  assertRepositorySetup(await page.getByTestId("open-app").getAttribute("href"), (await h.current()).repo);
  const setupOpened = page.waitForEvent("popup");
  await page.getByTestId("open-app").click();
  const setupPopup = await setupOpened;
  await expect(setupPopup).toHaveURL(await page.getByTestId("open-app").getAttribute("href"));
  await setupPopup.close();
  await expect(page.getByTestId("start-demo-session")).toBeVisible();
  const sessionOpened = page.waitForEvent("popup");
  await page.getByTestId("start-demo-session").click();
  const sessionPopup = await sessionOpened;
  await expect(sessionPopup).toHaveURL(await page.getByTestId("start-demo-session").getAttribute("href"));
  const target = new URL(new URL(sessionPopup.url()).searchParams.get("open"));
  assert.equal(target.host, "session");
  assert.equal(target.pathname, "/new");
  assert.equal(target.searchParams.get("repo"), (await h.current()).repo);
  await sessionPopup.close();
  await expect(page.getByTestId("start-demo-session")).toBeVisible();
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("open-app")).toBeHidden();
  await expect(page.getByTestId("start-demo-session")).toBeHidden();
  await expect(page.locator("#environment-info")).toBeHidden();
});

test("closing the reserved tab during provisioning retains both explicit launch stages", async (t) => {
  const h = await harness(t);
  h.remote.setupRun = { status: "in_progress", conclusion: null };
  const gate = Promise.withResolvers();
  h.source.sleep = () => gate.promise;
  const { page, url } = await canvas(t, h.source);
  await page.goto(url);
  const opened = page.waitForEvent("popup");
  await page.getByTestId("create-environment").click();
  const popup = await opened;
  try {
    await expect(page.locator("#setup-status")).toContainText("Waiting for CodeQL setup validation");
    await expect(page.getByTestId("start-demo-session")).toBeHidden();
    assert.equal(popup.url(), "about:blank");
    await popup.close();
  } finally {
    h.remote.setupRun = { status: "completed", conclusion: "success" };
    gate.resolve();
  }
  await expect(page.locator("#status")).toContainText("blocked or closed");
  assertRepositorySetup(await page.getByTestId("open-app").getAttribute("href"), (await h.current()).repo);
  await expect(page.getByTestId("start-demo-session")).toBeVisible();
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 1);
  assert.equal(h.messages.length, 0);
});

test("a newly created CodeQL run's 404 keeps the spinner active and opens setup for the same repository when ready", async (t) => {
  const h = await harness(t);
  h.remote.setupRun = { status: "in_progress", conclusion: null };
  h.remote.failure = (method, path) => method === "GET" && path.endsWith("/actions/runs/42")
    ? new GitHubError("Not Found", 404) : null;
  const gate = Promise.withResolvers();
  h.source.sleep = () => gate.promise;
  const { page, url } = await canvas(t, h.source);
  await page.goto(url);
  const opened = page.waitForEvent("popup");
  await page.getByTestId("create-environment").click();
  const popup = await opened;
  try {
    await expect(page.locator("#setup-status")).toContainText("Waiting for CodeQL setup validation");
    await expect(page.getByTestId("create-environment")).toBeDisabled();
    await expect(page.locator("#create-spinner")).toBeVisible();
    await expect(page.getByRole("alert")).toBeHidden();
    await expect(page.getByTestId("open-app")).toBeHidden();
    assert.equal(popup.url(), "about:blank");
    assert.equal(h.remote.pulls.length, 0);
  } finally {
    h.remote.failure = null;
    h.remote.setupRun = { status: "completed", conclusion: "success" };
    gate.resolve();
  }
  await expect(popup).toHaveURL(/^https:\/\/github.com\/copilot\/app\/launch\?open=/);
  assertRepositorySetup(popup.url(), (await h.current()).repo);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/generate")).length, 1);
  assert.equal((await h.store.read()).environments.length, 1);
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await expect(page.locator("#create-spinner")).toBeHidden();
  await popup.close();
});

test("both launch stages stay hidden until the inherited canvas is verified on main", async (t) => {
  const h = await harness(t);
  const gate = Promise.withResolvers();
  h.source.api = async (method, path, body) => {
    if (method === "GET" && path.includes("/contents/.github/extensions/demo-launcher?ref=base-sha")) await gate.promise;
    return h.api(method, path, body);
  };
  const { page, url } = await canvas(t, h.source);
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto(url);
  try {
    await page.getByTestId("create-environment").click();
    await expect(page.locator("#setup-status")).toContainText("Verifying the published template canvas");
    await expect(page.getByTestId("open-app")).toBeHidden();
    await expect(page.getByTestId("start-demo-session")).toBeHidden();
    await expect(page.getByTestId("create-environment")).toBeDisabled();
    const environment = await h.current();
    assert.equal(environment.launcherCommit, undefined);
    assert.equal(environment.launcherReady, undefined);
    assert.equal(h.remote.mainSha, "base-sha");
  } finally {
    gate.resolve();
  }
  await expect(page.getByTestId("open-app")).toBeVisible();
  assertRepositorySetup(await page.getByTestId("open-app").getAttribute("href"), (await h.current()).repo);
  const target = new URL(new URL(await page.getByTestId("start-demo-session").getAttribute("href")).searchParams.get("open"));
  assert.equal(target.searchParams.get("branch"), "main");
  assert.equal((await h.current()).launcherVerifiedCommit, h.remote.mainSha);
  await expect(page.getByTestId("create-environment")).toBeEnabled();
});

test("instance canvas runs game search locally and remains accessible in both themes", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  const { page, url } = await canvas(t, h.controller);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("create-environment")).toBeHidden();
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "Copilot Autofix", exact: true })).toBeVisible();
  await expect(page.getByText("GITHUB ADVANCED SECURITY", { exact: true })).toBeVisible();
  await page.getByTestId("refresh-security").click();
  await expect(page.locator("#scan-status")).toContainText("Waiting for CodeQL");
  await page.getByTestId("prompt-summary").click();
  await expect(page.locator("#feature-prompt")).toContainText("case-insensitive filtering");
  await page.getByTestId("run-feature").click();
  await expect(page.locator("#feature-status")).toContainText("requested in this session");
  assert.match(h.messages[0].prompt, /directly in this verified demo session/);
  assert.equal(page.url(), url);
  await finish(h, "feature");
  await expect(page.locator("#feature-status")).toContainText("completed in this demo session");
  await page.getByTestId("cleanup").click();
  await expect(page.getByRole("dialog")).toContainText("Demo control room");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("cleanup")).toBeFocused();
  assert.equal(h.messages.length, 1);
  await page.setViewportSize({ width: 375, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  for (const theme of ["light", "dark"]) {
    await page.goto(`${url}?clawpilotTheme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const results = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), [], theme);
  }
  await page.goto(url);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
    document.documentElement.style.setProperty("--background-color-default", "#151b23");
    document.documentElement.style.setProperty("--text-color-default", "#f0f6fc");
    document.documentElement.style.setProperty("--true-color-blue", "#79c0ff");
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(21, 27, 35)");
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(({ id }) => id), []);
  assert.deepEqual(errors, []);
});

test("instance scenarios launch issue work, request review, and gate repair on fresh failing CI", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  const environment = await h.current();
  const { page, url } = await canvas(t, h.controller);
  await page.goto(url);
  await expect(page.getByTestId("issue-link")).toHaveAttribute("href", `https://github.com/${environment.repo}/issues/${environment.scenarios.issue.number}`);
  await expect(page.getByTestId("review-link")).toHaveAttribute("href", `https://github.com/${environment.repo}/pull/${environment.scenarios.review.number}`);
  await expect(page.getByTestId("run-ci")).toBeDisabled();
  await page.getByTestId("run-issue").click();
  await expect(page.locator("#issue-status")).toContainText("Handoff requested");
  assert.match(h.messages[0].prompt, /open_issue_session/);
  await expect(page.getByTestId("run-issue")).toBeDisabled();
  await finish(h, "issue");
  await expect(page.locator("#issue-status")).toContainText("delivered");
  h.controller.requestReview = async () => { throw new Error("Copilot review is unavailable under the current account policy"); };
  await page.getByTestId("run-review").click();
  await expect(page.locator("#error")).toContainText("account policy");
  h.controller.requestReview = async (repo, number) => h.remote.reviewRequests.push({ repo, number });
  await page.getByTestId("run-review").click();
  await expect(page.locator("#review-status")).toContainText("requested");
  await expect(page.getByTestId("run-review")).toBeDisabled();
  const review = h.remote.pulls.find(({ number }) => number === environment.scenarios.review.number);
  h.remote.reviews = [{ user: { login: "Copilot", type: "Bot" }, commit_id: review.head.sha, submitted_at: "2026-10-06" }];
  await page.getByTestId("check-review").click();
  await expect(page.locator("#review-status")).toContainText("submitted for the current commit");
  await page.getByTestId("check-ci").click();
  await expect(page.locator("#ci-status")).toContainText("Waiting for the current PR");
  const ci = h.remote.pulls.find(({ number }) => number === environment.scenarios.ci.number);
  h.remote.ciRuns = [{ id: 71, head_sha: ci.head.sha, status: "completed", conclusion: "failure" }];
  h.remote.ciJobs = [{ name: "unit-tests", steps: [{ name: "Run unit tests", conclusion: "failure" }] }];
  await page.getByTestId("check-ci").click();
  await expect(page.getByTestId("ci-run-link")).toHaveAttribute("href", `https://github.com/${environment.repo}/actions/runs/71`);
  await expect(page.getByTestId("run-ci")).toBeEnabled();
  await page.getByTestId("run-ci").click();
  await expect(page.locator("#ci-status")).toContainText("Handoff requested");
  assert.match(h.messages[1].prompt, /open_pr_session/);
  await finish(h, "ci");
  h.remote.ciRuns[0].conclusion = "success";
  await page.getByTestId("check-ci").click();
  await expect(page.locator("#ci-status")).toContainText("checks are green");
  await expect(page.getByTestId("run-ci")).toBeDisabled();
  await page.reload();
  await expect(page.locator("#ci-status")).toContainText("checks are green");
  assert.equal(h.messages.length, 2);
});

test("cleanup requires named confirmation and returns its manual-removal notice without making core stateful", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  const { page, url } = await canvas(t, h.controller);
  await page.goto(url);
  await page.getByTestId("cleanup").click();
  await expect(page.getByRole("dialog")).toContainText((await h.current()).repo);
  await expect(page.getByRole("dialog")).toContainText("Demo control room");
  await page.getByTestId("cancel-cleanup").click();
  assert.equal(h.messages.length, 0);
  await page.getByTestId("cleanup").click();
  await page.getByTestId("confirm-cleanup").click();
  await expect(page.locator("#cleanup-status")).toContainText("not complete");
  await expect(page.locator("#demos")).toBeHidden();
  await page.getByTestId("cleanup").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("cleanup")).toBeEnabled();
  assert.equal(h.messages.length, 1, "Escape must not repeat an earlier deletion confirmation");
  const environment = await h.current();
  const input = { environmentId: environment.id, requestId: environment.request.id };
  assert.match(h.messages[0].prompt, /session_id="source-session"/);
  assert.equal(h.calls.filter(({ method }) => method === "DELETE").length, 0);
  await h.source.cleanupRepository(input);
  const result = await h.source.receipt({ ...input, kind: "cleanup", status: "done", removedSessionIds: ["demo-session"] });
  assert.match(result.lastCleanup.message, /Final manual step/);
  assert.match(result.lastCleanup.message, /Local project files have not been removed/);
  const sourceServer = await startServer(h.source);
  t.after(sourceServer.close);
  await page.goto(sourceServer.url);
  await expect(page.locator("#cleanup-section")).toBeHidden();
  await expect(page.locator("#environment-info")).toBeHidden();
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("create-environment")).toBeEnabled();
  await expect(page.locator("#environment-info")).toBeHidden();
});

test("unrecognized repos and stale providers cannot expose destructive or demo controls", async (t) => {
  const h = await harness(t);
  const controller = h.makeController("presenter/unrelated", "unrelated-session");
  const { page, url } = await canvas(t, controller);
  await page.goto(url);
  await expect(page.locator("#instance-status")).toContainText("No resources will be changed");
  for (const id of ["create-environment", "cleanup", "run-feature", "run-issue", "run-review", "run-ci"]) {
    await expect(page.getByTestId(id)).toBeHidden();
  }
  controller.state = () => h.store.read();
  await page.reload();
  await expect(page.locator("#error")).toContainText("Reload extensions");
  assert.equal(h.calls.length, 0);
});
