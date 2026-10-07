import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repositoryFromRemote } from "./workspace.mjs";
import { LAUNCH_BRANCH, RUNTIME_FILES, launchUrl, provisionLauncher } from "./launch.mjs";
import { DEMO_OWNER, GitHubError, SOURCE_REPOSITORIES, TEMPLATE, UPSTREAM_REPOSITORY } from "./github.mjs";
import { harness } from "./test-support.mjs";

const confirmation = (environment) => ({
  confirmRepo: environment.repo,
  confirmedSessions: (environment.cleanup?.sessions || environment.sessions).map(({ id, name }) => ({ id, name })),
});

test("repository detection accepts GitHub SSH/HTTPS remotes and rejects lookalikes", () => {
  for (const repo of SOURCE_REPOSITORIES) {
    for (const remote of [`https://github.com/${repo}.git`, `git@github.com:${repo}.git`, `ssh://git@github.com/${repo}`]) {
      assert.equal(repositoryFromRemote(remote), repo);
    }
  }
  for (const remote of ["https://github.com.evil.example/github-samples/tailspin-toys", "/tmp/repo", "https://github.com/owner/repo/extra", "file:///owner/repo", "https://github.com:8443/owner/repo"]) {
    assert.throws(() => repositoryFromRemote(remote), /GitHub|github.com/);
  }
});

for (const repo of SOURCE_REPOSITORIES) {
  test(`${repo} is a stateless source that creates in the demo organization`, async (t) => {
    const h = await harness(t);
    const source = h.makeController(repo.toUpperCase(), "source-session");
    assert.equal((await source.state()).context.kind, "source");
    await source.create();
    const environment = await h.current();
    assert.equal(environment.owner, DEMO_OWNER);
    assert.equal(environment.createdBy, "presenter");
    assert.equal(environment.sourceRepo, repo.toUpperCase());
    assert.equal(h.calls.find(({ path }) => path.endsWith("/generate")).path, `repos/${TEMPLATE}/generate`);
    assert.deepEqual((await source.state()).environments, []);
    await h.link();
    await h.controller.cleanup(confirmation(await h.current()));
    assert.ok(h.messages[0].prompt.includes(`verify it belongs to ${repo.toUpperCase()}.`));
    const requested = await h.current();
    await source.cleanupRepository({ environmentId: requested.id, requestId: requested.request.id });
    assert.equal(h.calls.filter(({ method }) => method === "DELETE").length, 1);
  });
}

test("the source is stateless while each instance retains its own environment", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  const first = await h.current();
  assert.equal((await h.source.state()).context.kind, "source");
  assert.equal((await h.controller.state()).context.kind, "demo");
  await assert.rejects(h.source.feature(), /Open the new repository/);
  await assert.rejects(h.controller.create(), /core repository/);
  await h.create();
  const source = await h.source.state();
  assert.equal(source.environments.length, 0);
  assert.equal(source.activeId, null);
  assert.equal((await h.store.read()).environments.length, 2);
  const demo = await h.controller.state();
  assert.equal(demo.activeId, first.id);
  assert.deepEqual(demo.environments.map(({ repo }) => repo), [first.repo]);
  const unknown = h.makeController("presenter/unrelated", "unrelated-session");
  assert.equal((await unknown.state()).context.kind, "unrecognized");
  await assert.rejects(unknown.feature(), /not a recorded demo/);
  await assert.rejects(unknown.cleanup({ confirmRepo: first.repo }), /not a recorded demo/);
});

test("only the verified canvas runtime is merged into the demo's main before launch", async (t) => {
  const h = await harness(t);
  const created = await h.create();
  const environment = await h.current();
  const tree = h.remote.trees[0];
  assert.equal(tree.base_tree, "base-tree");
  assert.deepEqual(tree.tree.map(({ path }) => path), RUNTIME_FILES.map((file) => `.github/extensions/demo-launcher/${file}`));
  assert.ok(tree.tree.every(({ mode, type, content }) => mode === "100644" && type === "blob" && content.length > 0));
  for (const file of RUNTIME_FILES) {
    assert.equal(tree.tree.find(({ path }) => path.endsWith(`/${file}`)).content, await readFile(new URL(file, import.meta.url), "utf8"));
  }
  const commit = h.remote.commits.get(environment.launcherCommit);
  assert.deepEqual(commit.parents, ["base-sha"]);
  assert.equal(h.remote.branches.get(LAUNCH_BRANCH).object.sha, environment.launcherCommit);
  const url = new URL(created.environments[0].launchUrl);
  assert.equal(url.origin, "https://github.com");
  const target = new URL(url.searchParams.get("open"));
  assert.equal(target.protocol, "ghapp:");
  assert.equal(target.host, "session");
  assert.equal(target.pathname, "/new");
  assert.equal(target.searchParams.get("repo"), environment.repo);
  assert.equal(target.searchParams.get("branch"), "main");
  assert.match(target.searchParams.get("prompt"), /get_session[\s\S]*bind_session/);
  const prompt = target.searchParams.get("prompt");
  assert.ok(prompt.includes(`commit ${environment.launcherMergeCommit}`));
  assert.match(prompt, /entire demo-launcher directory is absent[\s\S]*restore ONLY \.github\/extensions\/demo-launcher/);
  assert.match(prompt, /do not overwrite existing work, partially present files, or symlinks/);
  assert.match(prompt, /extensions_reload[\s\S]*extensions_manage[\s\S]*list_canvas_capabilities[\s\S]*open_canvas[\s\S]*bind_session/);
  assert.match(prompt, /even if copilot-demos was absent/);
  assert.ok(h.calls.some(({ method, path }) => method === "GET" && path.endsWith(`/contents/.github/extensions/demo-launcher?ref=${environment.launcherCommit}`)));
  assert.ok(h.calls.some(({ method, path }) => method === "GET" && path.endsWith(`/contents/.github/extensions/demo-launcher?ref=${environment.launcherMergeCommit}`)));
  const merges = h.calls.filter(({ method, path }) => method === "POST" && path.endsWith("/merges"));
  assert.equal(merges.length, 1);
  assert.equal(merges[0].path, `repos/${environment.repo}/merges`);
  assert.equal(merges[0].body.base, "main");
  assert.equal(merges[0].body.head, environment.launcherCommit);
  assert.equal(environment.launcherMergeCommit, h.remote.mainSha);
  assert.equal(h.remote.pulls.filter(({ state }) => state === "open").length, 3);
  assert.equal(h.calls.some(({ path }) => /\/pulls\/\d+\/merge$/.test(path)), false);
  assert.equal(h.messages.length, 0);
});

test("an older unmerged launcher receipt cannot expose an app launch link", () => {
  assert.equal(launchUrl({ repo: "presenter/demo", defaultBranch: "main", launcherReady: true, launcherCommit: "old-commit" }), null);
});

for (const status of [403, 409]) {
  test(`a merge HTTP ${status} keeps the app launch unavailable`, async (t) => {
    const h = await harness(t);
    h.remote.failure = (method, path) => method === "POST" && path.endsWith("/merges")
      ? new GitHubError(`Merge rejected (${status})`, status) : null;
    await assert.rejects(h.create(), /Merge rejected/);
    const environment = await h.current();
    assert.equal(environment.launcherReady, undefined);
    assert.equal(environment.launcherMergeCommit, undefined);
    assert.equal(launchUrl(environment), null);
    assert.equal(h.remote.mainSha, "base-sha");
    assert.deepEqual((await h.source.state()).environments, []);
  });
}

for (const failure of ["unmerged main", "wrong main contents", "unrelated branch changes"]) {
  test(`${failure} cannot satisfy the merge readiness gate`, async (t) => {
    const h = await harness(t);
    h.source.api = async (method, path, body) => {
      const result = await h.api(method, path, body);
      if (failure === "unmerged main" && path.endsWith("/git/ref/heads/main")) {
        return { object: { sha: "base-sha" } };
      }
      if (failure === "wrong main contents" && path.includes("/contents/.github/extensions/demo-launcher?ref=merge-")) {
        result[0].sha = "different-canvas";
      }
      if (failure === "unrelated branch changes" && path.includes("/compare/base-sha...")) {
        result.files.push({ filename: "demo-security/preview.mjs", status: "added" });
      }
      return result;
    };
    await assert.rejects(h.create(), /merge is not visible|verification failed|outside the canvas runtime/);
    const environment = await h.current();
    assert.equal(environment.launcherReady, undefined);
    assert.equal(launchUrl(environment), null);
    if (failure === "unrelated branch changes") {
      assert.equal(h.calls.filter(({ path }) => path.endsWith("/merges")).length, 0);
    }
  });
}

test("readiness waits for main to reflect the completed merge", async (t) => {
  const h = await harness(t);
  let delayedReads = 0;
  let waits = 0;
  h.source.sleep = async () => { waits += 1; };
  h.source.api = async (method, path, body) => {
    const result = await h.api(method, path, body);
    if (path.endsWith("/git/ref/heads/main") && h.remote.mainSha !== "base-sha" && delayedReads++ < 2) {
      return { object: { sha: "base-sha" } };
    }
    return result;
  };
  await h.create();
  assert.equal(waits, 2);
  assert.equal((await h.current()).launcherReady, true);
});

test("a lost merge response is recovered by verifying ancestry without merging twice", async (t) => {
  const h = await harness(t);
  h.source.api = async (method, path, body) => {
    const result = await h.api(method, path, body);
    if (method === "POST" && path.endsWith("/merges")) throw new Error("Lost merge response");
    return result;
  };
  await assert.rejects(h.create(), /Lost merge response/);
  const state = await h.store.read();
  await provisionLauncher(state.environments[0], { api: h.api, save: () => h.store.write(state) });
  assert.equal((await h.current()).launcherReady, true);
  assert.equal(h.calls.filter(({ method, path }) => method === "POST" && path.endsWith("/merges")).length, 1);
});

for (const repo of SOURCE_REPOSITORIES) {
  test(`${repo} can never be a canvas merge target`, async () => {
    const environment = { id: "source-attempt", repo, defaultBranch: "main" };
    const calls = [];
    const api = async (method, path) => {
      calls.push({ method, path });
      return { full_name: repo, description: `Disposable Copilot demo [${environment.id}]`, private: false, fork: false };
    };
    await assert.rejects(provisionLauncher(environment, { api, save: async () => {} }), /identity/);
    assert.deepEqual(calls, [{ method: "GET", path: `repos/${repo}` }]);
  });

  test(`cleanup cannot delete ${repo} even with a matching receipt marker`, async (t) => {
    const h = await harness(t);
    await h.create();
    await h.link();
    await h.controller.cleanup(confirmation(await h.current()));
    const state = await h.store.read();
    const environment = state.environments[0];
    environment.repo = repo;
    h.remote.repository.full_name = repo;
    await h.store.write(state);
    h.source.api = (method, path, body) => method === "GET" && path === `repos/${repo}`
      ? h.remote.repository : h.api(method, path, body);
    await assert.rejects(h.source.cleanupRepository({ environmentId: environment.id, requestId: environment.request.id }), /identity/);
    assert.equal(h.calls.filter(({ method }) => method === "DELETE").length, 0);
  });
}

test("organization cleanup requires the creating account, not the organization login", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await h.controller.cleanup(confirmation(await h.current()));
  const environment = await h.current();
  h.source.api = (method, path, body) => path === "user"
    ? { login: "another-presenter" } : h.api(method, path, body);
  await assert.rejects(h.source.cleanupRepository({ environmentId: environment.id, requestId: environment.request.id }), /account that created/);
  assert.equal(h.calls.filter(({ method }) => method === "DELETE").length, 0);
});

test("legacy personal receipts still route cleanup to the original source and creator", async (t) => {
  const h = await harness(t);
  await h.create();
  const state = await h.store.read();
  const environment = state.environments[0];
  environment.owner = "presenter";
  environment.repo = `presenter/${environment.name}`;
  delete environment.createdBy;
  delete environment.sourceRepo;
  h.remote.repository.full_name = environment.repo;
  await h.store.write(state);
  await h.link();
  await h.controller.cleanup(confirmation(await h.current()));
  assert.ok(h.messages[0].prompt.includes(`verify it belongs to ${UPSTREAM_REPOSITORY}.`));
  const requested = await h.current();
  await h.makeController(UPSTREAM_REPOSITORY).cleanupRepository({ environmentId: requested.id, requestId: requested.request.id });
  assert.equal(h.calls.filter(({ method }) => method === "DELETE").length, 1);
});

test("a changed demo default branch cannot redirect the canvas merge", async (t) => {
  const h = await harness(t);
  h.source.api = async (method, path, body) => {
    const result = await h.api(method, path, body);
    if (method === "POST" && body?.ref === `refs/heads/${LAUNCH_BRANCH}`) {
      h.remote.repository.default_branch = "demo/copilot-autofix";
    }
    return result;
  };
  await assert.rejects(h.create(), /default branch changed/);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/merges")).length, 0);
});

for (const failure of ["missing file", "wrong contents", "symlink", "permission error"]) {
  test(`launcher readback rejects ${failure} instead of advertising a ready canvas`, async (t) => {
    const h = await harness(t);
    h.source.api = async (method, path, body) => {
      const result = await h.api(method, path, body);
      if (!path.includes("/contents/.github/extensions/demo-launcher?ref=")) return result;
      if (failure === "permission error") throw new GitHubError("Forbidden to read published files", 403);
      if (failure === "missing file") return result.slice(1);
      if (failure === "wrong contents") result[0].sha = "not-the-uploaded-file";
      if (failure === "symlink") result[0].type = "symlink";
      return result;
    };
    await assert.rejects(h.create(), /verification failed|Forbidden to read/);
    const environment = await h.current();
    assert.equal(environment.launcherReady, undefined);
    assert.equal(environment.step, "Verifying the published canvas files");
    const demo = await h.makeController(environment.repo).state();
    assert.equal(demo.environments[0].launchUrl, null);
    assert.deepEqual((await h.source.state()).environments, []);
    assert.equal(h.messages.length, 0);
  });
}

test("launcher readback rejects a branch that moved before launch", async (t) => {
  const h = await harness(t);
  h.source.api = async (method, path, body) => {
    const result = await h.api(method, path, body);
    if (method === "POST" && body?.ref === `refs/heads/${LAUNCH_BRANCH}`) result.object.sha = "unexpected-commit";
    return result;
  };
  await assert.rejects(h.create(), /no longer points/);
  assert.equal((await h.current()).launcherReady, undefined);
});

test("a lost launcher ref response resumes without duplicating commits or overwriting a changed branch", async (t) => {
  const h = await harness(t);
  const api = h.source.api;
  h.source.api = async (method, path, body) => {
    const result = await api(method, path, body);
    if (method === "POST" && body?.ref === `refs/heads/${LAUNCH_BRANCH}`) {
      h.source.api = api;
      throw new Error("Lost launcher ref response");
    }
    return result;
  };
  await assert.rejects(h.create(), /Lost launcher/);
  const saved = await h.store.read();
  await provisionLauncher(saved.environments[0], { api, save: () => h.store.write(saved) });
  assert.equal(h.calls.filter(({ method, path }) => method === "POST" && path.endsWith("/git/commits")).length, 1);
  const environment = await h.current();
  assert.equal(environment.launcherReady, true);
  delete environment.launcherReady;
  h.remote.commits.get(environment.launcherCommit).message = "unrelated work";
  await assert.rejects(provisionLauncher(environment, { api, save: async () => {} }), /will not be overwritten/);
});

test("cleanup needs confirmed names, runs remote deletion only in core, and cannot report forwarding as completion", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  const environment = await h.current();
  await assert.rejects(h.controller.cleanup({ confirmRepo: environment.repo }), /session list/);
  await assert.rejects(h.controller.cleanup({ ...confirmation(environment), confirmRepo: TEMPLATE }), /exact demo/);
  await assert.rejects(h.source.cleanup(confirmation(environment)), /Start cleanup/);
  await h.controller.cleanup(confirmation(environment));
  const requested = await h.current();
  const input = { environmentId: requested.id, requestId: requested.request.id };
  assert.match(h.messages[0].prompt, /Do not delete this active demo session yourself/);
  assert.match(h.messages[0].prompt, /session_id="source-session"/);
  assert.match(h.messages[0].prompt, /delete_item/);
  assert.match(h.messages[0].prompt, /Project removal is not available/);
  assert.equal(h.calls.filter(({ method }) => method === "DELETE").length, 0);
  await assert.rejects(h.controller.cleanupRepository(input), /core repository/);
  await assert.rejects(h.makeController(TEMPLATE, "wrong-core-session").cleanupRepository(input), /No matching confirmed/);
  await assert.rejects(h.source.receipt({ ...input, kind: "cleanup", status: "done", removedSessionIds: ["demo-session"] }), /must be removed/);
  await assert.rejects(h.controller.feature(), /Cleanup has started/);
  await h.source.cleanupRepository(input);
  await h.source.cleanupRepository(input);
  assert.equal(h.calls.filter(({ method }) => method === "DELETE").length, 1);
  await assert.rejects(h.source.receipt({ ...input, kind: "cleanup", status: "done", removedSessionIds: [] }), /all confirmed sessions/);
  const final = await h.source.receipt({ ...input, kind: "cleanup", status: "done", removedSessionIds: ["demo-session"] });
  assert.equal(final.environments.length, 0);
  assert.match(final.lastCleanup.message, /Final manual step/);
  assert.match(final.lastCleanup.message, /Local project files have not been removed/);
});

test("permission failure preserves cleanup receipts, retry does not self-message, and stale receipts fail", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await h.controller.cleanup(confirmation(await h.current()));
  const environment = await h.current();
  const input = { environmentId: environment.id, requestId: environment.request.id };
  h.remote.failure = (method) => method === "DELETE" ? new GitHubError("Missing delete_repo permission", 403) : null;
  await assert.rejects(h.source.cleanupRepository(input), /delete_repo/);
  assert.equal((await h.current()).cleanup.repoDeleted, false);
  assert.ok(h.remote.repository);
  await h.source.receipt({ ...input, kind: "cleanup", status: "failed", message: "Missing delete_repo permission" });
  h.remote.failure = null;
  await h.source.cleanup({ ...confirmation(await h.current()), retry: true });
  assert.doesNotMatch(h.messages[1].prompt, /send_session_message/);
  await assert.rejects(h.source.cleanupRepository(input), /No matching confirmed/);
  const retried = await h.current();
  await h.source.cleanupRepository({ environmentId: retried.id, requestId: retried.request.id });
  assert.equal((await h.current()).cleanup.repoDeleted, true);
});

test("Create remains independent of another demo's pending cleanup and scopes cleanup errors correctly", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  const repository = structuredClone(h.remote.repository);
  await h.controller.cleanup(confirmation(await h.current()));
  const original = await h.current();
  await h.create();
  assert.deepEqual((await h.store.read()).environments[0], original);
  assert.deepEqual((await h.source.state()).environments, []);
  h.source.api = (method, path, body) => {
    if (path === `repos/${original.repo}`) {
      if (method === "DELETE") throw new GitHubError("Missing delete_repo permission", 403);
      return repository;
    }
    return h.api(method, path, body);
  };
  await assert.rejects(h.source.cleanupRepository({ environmentId: original.id, requestId: original.request.id }), /delete_repo/);
  const state = await h.store.read();
  assert.match(state.environments[0].error, /delete_repo/);
  assert.equal(state.environments[1].error, undefined);
});

test("cleanup rejects a changed repository ID and a session added after the confirmation was displayed", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  const oldConfirmation = confirmation(await h.current());
  await h.controller.bindSession({ repo: (await h.current()).repo, projectId: "demo-project", sessionId: "second-demo", sessionName: "Second demo session" });
  await assert.rejects(h.controller.cleanup(oldConfirmation), /session list changed/);
  await h.controller.cleanup(confirmation(await h.current()));
  const environment = await h.current();
  h.remote.repository.id = 999;
  await assert.rejects(h.source.cleanupRepository({ environmentId: environment.id, requestId: environment.request.id }), /identity/);
  assert.equal(h.calls.filter(({ method }) => method === "DELETE").length, 0);
});
