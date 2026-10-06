import { assertOwnedRepository, optional, pullRequestBody } from "./github.mjs";

export const REVIEW_BRANCH = "demo/code-review";
export const CI_BRANCH = "demo/failing-ci";
export const REVIEW_PATH = "src/lib/demo-review-pagination.ts";
export const CI_PATH = "src/lib/demo-page-count.ts";
export const CI_TEST_PATH = "src/lib/demo-page-count.test.ts";

// Deliberate bugs stay as text here and are materialized only on disposable PR branches.
export const REVIEW_SOURCE = `/** Return a one-based page without modifying the original list. */
export function pageOf<T>(items: readonly T[], page: number, pageSize: number): T[] {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('Page and page size must be positive integers.');
  }
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}
`;

export const CI_SOURCE = `export function pageCount(total: number, pageSize: number): number {
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('Total must be nonnegative and page size must be positive integers.');
  }
  return Math.floor(total / pageSize);
}
`;

export const CI_TEST = `import { describe, expect, it } from 'vitest';
import { pageCount } from './demo-page-count';

describe('pageCount', () => {
  it.each([
    [0, 10, 0],
    [20, 10, 2],
    [21, 10, 3],
    [1, 10, 1],
  ])('counts pages for %i games with a page size of %i', (total: number, size: number, expected: number) => {
    expect(pageCount(total, size)).toBe(expected);
  });
  it('rejects a zero page size', () => {
    expect(() => pageCount(21, 0)).toThrow(RangeError);
  });
});
`;

export function scenarioMarker(environment, kind) {
  return `<!-- tailspin-demo:${environment.id}:${kind} -->`;
}

async function listAll(api, path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await api("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

export function assertScenarioPull(environment, kind, pull) {
  const branch = kind === "review" ? REVIEW_BRANCH : CI_BRANCH;
  if (pull.head.ref !== branch || pull.head.repo?.full_name !== environment.repo ||
      pull.base.ref !== environment.defaultBranch || !pull.body?.includes(scenarioMarker(environment, kind))) {
    throw new Error(`The ${kind} PR no longer matches its demo receipt. Refusing to use it.`);
  }
}

export async function scenarioPull(environment, kind, api) {
  const number = environment.scenarios?.[kind]?.number;
  if (!number) throw new Error("Resume setup to prepare this demo's PR.");
  assertOwnedRepository(environment, await api("GET", `repos/${environment.repo}`));
  const pull = await api("GET", `repos/${environment.repo}/pulls/${number}`);
  assertScenarioPull(environment, kind, pull);
  if (pull.state !== "open") throw new Error("This demo PR is closed. Create a fresh environment for another run.");
  return pull;
}

export async function scenarioIssue(environment, api) {
  const number = environment.scenarios?.issue?.number;
  if (!number) throw new Error("Resume setup to prepare the pagination issue.");
  assertOwnedRepository(environment, await api("GET", `repos/${environment.repo}`));
  const issue = await api("GET", `repos/${environment.repo}/issues/${number}`);
  if (issue.pull_request || !issue.body?.includes(scenarioMarker(environment, "issue"))) {
    throw new Error("The issue no longer matches its demo receipt.");
  }
  if (issue.state !== "open") throw new Error("The demo issue is closed. Create a fresh environment for another run.");
  return issue;
}

export async function provisionScenarios(environment, { api, save }) {
  const prefix = `repos/${environment.repo}`;
  assertOwnedRepository(environment, await api("GET", prefix));
  environment.scenarios ||= {};
  environment.step = "Preparing issue-to-PR demo";
  await save();
  if (!environment.scenarios.issue) {
    const marker = scenarioMarker(environment, "issue");
    const issues = await listAll(api, `${prefix}/issues?state=all&creator=${environment.owner}`);
    let issue = issues.find((item) => !item.pull_request && item.body?.includes(marker));
    if (!issue) {
      issue = await api("POST", `${prefix}/issues`, {
        title: "Demo: Add pagination to the game catalog",
        body: `### Problem statement\n\nThe growing game catalog is difficult to browse on one long page.\n\n### Proposed solution\n\nAdd static, accessible pagination with 10 games per page, stable alphabetical ordering, previous/next navigation, and a page indicator. Preserve the dark theme and existing game links. Handle empty catalogs and page boundaries. Add focused Vitest and Playwright coverage with data-testid attributes.\n\n### Alternatives considered\n\nClient-side filtering alone does not keep each page manageable.\n\n### Additional context\n\nThis is an issue-to-PR demo in a disposable repository. Implement on a separate worktree branch, verify, and open a PR linked to this issue; do not merge it. Keep review and CI demo fixtures out of this branch.\n\n${marker}`,
      });
    }
    environment.scenarios.issue = { number: issue.number };
    await save();
  }

  for (const [kind, branch, files, title, description] of [
    ["review", REVIEW_BRANCH, [[REVIEW_PATH, REVIEW_SOURCE]], "Demo: Add a one-based pagination helper",
      "Review this one-based pagination helper. Page 1 should return the first page, subsequent pages should not skip records, and the input list must remain unchanged. This isolated presentation PR intentionally contains a logic bug; do not merge it."],
    ["ci", CI_BRANCH, [[CI_PATH, CI_SOURCE], [CI_TEST_PATH, CI_TEST]], "Demo: Count catalog pages",
      "Count every catalog page, including a partially filled final page. The unit tests express the expected behavior. This isolated presentation PR intentionally starts with a failing test; diagnose and fix the implementation, never weaken the tests or workflow. Do not merge it."],
  ]) {
    if (environment.scenarios[kind]) continue;
    environment.step = `Preparing ${kind === "review" ? "code review" : "failing CI"} demo`;
    await save();
    const marker = scenarioMarker(environment, kind);
    const pulls = await listAll(api, `${prefix}/pulls?state=all&head=${encodeURIComponent(`${environment.owner}:${branch}`)}`);
    let pull = pulls.find((item) => item.body?.includes(marker));
    if (!pull && pulls.length) throw new Error(`An unrelated PR uses ${branch}. Refusing to reuse it.`);
    if (pull) {
      assertScenarioPull(environment, kind, pull);
    } else {
      if (!await optional(api, `${prefix}/git/ref/heads/${branch}`)) {
        const base = await api("GET", `${prefix}/git/ref/heads/${encodeURIComponent(environment.defaultBranch)}`);
        await api("POST", `${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.object.sha });
      }
      for (const [path, source] of files) {
        const existing = await optional(api, `${prefix}/contents/${path}?ref=${encodeURIComponent(branch)}`);
        if (existing) {
          if (Buffer.from(existing.content, "base64").toString("utf8") !== source) {
            throw new Error(`The ${kind} fixture was edited. Refusing to overwrite it; use a fresh environment.`);
          }
        } else {
          await api("PUT", `${prefix}/contents/${path}`, {
            branch, content: Buffer.from(source).toString("base64"),
            message: `demo: prepare ${kind} fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`,
          });
        }
      }
      pull = await api("POST", `${prefix}/pulls`, {
        title, head: branch, base: environment.defaultBranch,
        body: await pullRequestBody(environment, {
          description, changes: files.map(([path]) => `- Adds \`${path}\`.`).join("\n"),
          testing: "`npm run test:unit`, `npm run lint`, and `npm run build` were not run by provisioning. The existing Actions workflow runs on this PR. Unchecked template items do not assert success.",
          notes: `${marker}\n\nUse the canvas to ${kind === "review" ? "request Copilot code review (an eligible plan is required)" : "check the current unit-test failure and ask Copilot to repair this PR"}.`,
        }),
      });
    }
    environment.scenarios[kind] = { number: pull.number };
    await save();
  }
  environment.scenariosReady = true;
  environment.step = "All five demos prepared";
  await save();
}

function isCopilot(user) {
  return user?.type === "Bot" && ["copilot", "copilot-pull-request-reviewer[bot]"].includes(user.login.toLowerCase());
}

export async function reviewStatus(environment, api) {
  const pull = await scenarioPull(environment, "review", api);
  const prefix = `repos/${environment.repo}/pulls/${pull.number}`;
  const [requested, reviews] = await Promise.all([
    api("GET", `${prefix}/requested_reviewers`),
    listAll(api, `${prefix}/reviews`),
  ]);
  if (reviews.some((review) => isCopilot(review.user) && review.commit_id === pull.head.sha && review.submitted_at)) {
    return { state: "reviewed", head: pull.head.sha, message: "Copilot review submitted for the current commit. Open the PR to inspect its feedback." };
  }
  if (requested.users.some(isCopilot)) return { state: "requested", head: pull.head.sha, message: "Copilot review requested; waiting for feedback." };
  if (environment.scenarios.review.requestedHead === pull.head.sha) {
    return { state: "requested", head: pull.head.sha, message: "A review request was sent for this commit, but no completed review is visible yet. Open the PR to check its status." };
  }
  return { state: "available", head: pull.head.sha, message: "PR prepared. Request Copilot review to begin; results depend on account policy and processing." };
}

export async function ciStatus(environment, api) {
  const pull = await scenarioPull(environment, "ci", api);
  const prefix = `repos/${environment.repo}`;
  const { workflow_runs: runs } = await api("GET", `${prefix}/actions/workflows/run-tests.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`);
  const run = runs.filter((item) => item.head_sha === pull.head.sha).sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== "completed") return { state: "pending", message: "Waiting for the current PR's Run tests workflow. Check again in a moment." };
  const status = { head: pull.head.sha, runId: run.id };
  if (run.conclusion === "success") return { ...status, state: "passed", message: "The current PR's checks are green. Open the run to show the result." };
  const { jobs } = await api("GET", `${prefix}/actions/runs/${run.id}/jobs?per_page=100`);
  const unitFailure = jobs.some((job) => job.name === "unit-tests" &&
    job.steps?.some((step) => step.name === "Run unit tests" && step.conclusion === "failure"));
  if (run.conclusion === "failure" && unitFailure) {
    return { ...status, state: "failed", message: "The current unit-test step failed. Ready for Copilot to inspect the logs and fix the implementation." };
  }
  return { ...status, state: "blocked", message: `Run tests ended with ${run.conclusion}, but the expected unit-test step failure was not observed. Inspect Actions before running the repair demo.` };
}
