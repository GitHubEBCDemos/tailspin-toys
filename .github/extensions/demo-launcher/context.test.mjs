import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repositoryFromRemote } from "./workspace.mjs";
import { RUNTIME_FILES, launchUrl, verifyLauncher } from "./launch.mjs";
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

test("the published template canvas is inherited and verified without any runtime writes or merges", async (t) => {
  const h = await harness(t);
  // Model a published runtime different from this development worktree.
  h.remote.templateFiles[0].sha = "b".repeat(40);
  const created = await h.create();
  const environment = await h.current();
  assert.deepEqual(h.remote.runtimeFiles, h.remote.templateFiles);
  assert.deepEqual(h.remote.runtimeFiles.map(({ path }) => path), RUNTIME_FILES.map((file) => `.github/extensions/demo-launcher/${file}`));
  const url = new URL(created.environments[0].launchUrl);
  assert.equal(created.interfaceVersion, 5);
  assert.equal(created.environments[0].setupUrl, undefined);
  assert.equal(url.origin, "https://github.com");
  const target = new URL(url.searchParams.get("open"));
  assert.equal(target.protocol, "ghapp:");
  assert.equal(target.host, "session");
  assert.equal(target.pathname, "/new");
  assert.equal(target.searchParams.get("repo"), environment.repo);
  assert.equal(target.searchParams.get("branch"), "main");
  const prompt = target.searchParams.get("prompt");
  assert.ok(prompt.includes(`Expected origin: ${environment.repo}; default branch: main; verified commit: ${environment.launcherVerifiedCommit}.`));
  assert.match(prompt, /BOOTSTRAP\.md from that commit using git show/);
  assert.ok(RUNTIME_FILES.includes("BOOTSTRAP.md"));
  assert.ok(h.calls.some(({ method, path }) => method === "GET" && path === `repos/${TEMPLATE}/contents/.github/extensions/demo-launcher?ref=${h.remote.templateSha}`));
  assert.ok(h.calls.some(({ method, path }) => method === "GET" && path === `repos/${environment.repo}/contents/.github/extensions/demo-launcher?ref=${environment.launcherVerifiedCommit}`));
  assert.equal(environment.launcherTemplateCommit, h.remote.templateSha);
  assert.equal(environment.launcherVerifiedCommit, h.remote.mainSha);
  assert.equal(environment.launcherMergeCommit, undefined);
  assert.equal(environment.launcherCommit, undefined);
  const writes = h.calls.filter(({ method }) => method !== "GET");
  assert.ok(writes.every(({ path, body }) => !path.endsWith("/merges") && !/\/git\/(trees|commits)$/.test(path) && !path.includes("/contents/.github/extensions/") && body?.ref !== "refs/heads/demo/launcher"));
  assert.ok(writes.filter(({ path }) => path.endsWith("/git/refs")).every(({ body }) => body.ref !== "refs/heads/main"));
  assert.equal(h.remote.pulls.filter(({ state }) => state === "open").length, 3);
  assert.equal(h.calls.some(({ path }) => /\/pulls\/\d+\/merge$/.test(path)), false);
  assert.equal(h.messages.length, 0);
});

test("an older unmerged launcher receipt cannot expose an app launch link", () => {
  assert.equal(launchUrl({ repo: "presenter/demo", defaultBranch: "main", launcherReady: true, launcherCommit: "old-commit" }), null);
});

test("cleanup hides the session launch link", async (t) => {
  const h = await harness(t);
  await h.create();
  await h.link();
  await h.controller.cleanup(confirmation(await h.current()));
  const state = await h.controller.state();
  assert.equal(state.environments[0].launchUrl, null);
  assert.equal(state.environments[0].setupUrl, undefined);
});

test("short kickoff reads the pinned guide without requiring unavailable lifecycle tools", () => {
  const verifiedCommit = "a".repeat(40);
  const url = new URL(launchUrl({
    repo: `${DEMO_OWNER}/tailspin-demo-bootstrap`, defaultBranch: "main",
    launcherReady: true, launcherVerifiedCommit: verifiedCommit,
  }));
  const target = new URL(url.searchParams.get("open"));
  assert.equal(target.searchParams.get("mode"), "interactive");
  const prompt = target.searchParams.get("prompt");
  assert.ok(prompt.length <= 750, `Kickoff must stay short; received ${prompt.length} characters.`);
  assert.match(prompt, /^Open the Copilot demos canvas\./);
  assert.doesNotMatch(prompt, /extensions_reload|extensions_manage|First tool call/);
  assert.ok(prompt.includes(`verified commit: ${verifiedCommit}.`));
  assert.match(prompt, /BOOTSTRAP\.md from that commit using git show \(fetch origin main only if needed\)/);
  assert.match(prompt, /Do not rewrite extension files or reload a working provider/);
});

test("legacy verified default-branch receipts still expose a launch link", () => {
  const url = launchUrl({ repo: "presenter/demo", defaultBranch: "main", launcherReady: true, launcherMergeCommit: "old-verified-main" });
  assert.ok(new URL(new URL(url).searchParams.get("open")).searchParams.get("prompt").includes("verified commit: old-verified-main."));
});

test("bootstrap uses an available canvas without reload or disk writes and diagnoses trust blockers", async () => {
  const guide = await readFile(new URL("BOOTSTRAP.md", import.meta.url), "utf8");
  assert.match(guide, /git show <verified-commit>:\.github\/extensions\/demo-launcher\/BOOTSTRAP\.md/);
  assert.match(guide, /verify the expected origin before fetching/);
  assert.match(guide, /Do not restore, rewrite, or overwrite extension files/);
  assert.match(guide, /Do not switch branches, modify the main checkout, commit, push, install software, create another repository, or run a demo automatically/);
  assert.match(guide, /If `copilot-demos` is already declared[\s\S]*`list_canvas_capabilities`[\s\S]*Do not reload or require lifecycle tools/);
  assert.match(guide, /Zero lifecycle tools is not itself a canvas failure/);
  assert.match(guide, /api_tool\.list_resources[\s\S]*extensions_reload[\s\S]*extensions_manage/);
  assert.match(guide, /Only reload if the provider is unavailable and `extensions_reload` was actually discovered/);
  assert.match(guide, /user must review and accept[\s\S]*Never accept on their behalf or bypass the trust gate/);
  assert.match(guide, /`list_canvas_capabilities`[\s\S]*`open_canvas`[\s\S]*`get_session`[\s\S]*`bind_session`/);
  assert.match(guide, /Read `get_state` again to confirm registration/);
});

for (const status of [403, 404]) {
  test(`published runtime readback HTTP ${status} keeps the app launch unavailable`, async (t) => {
    const h = await harness(t);
    h.remote.failure = (method, path) => method === "GET" && path.includes("/contents/.github/extensions/demo-launcher")
      ? new GitHubError(`Runtime unavailable (${status})`, status) : null;
    await assert.rejects(h.create(), /Runtime unavailable/);
    const environment = await h.current();
    assert.equal(environment.launcherReady, undefined);
    assert.equal(environment.launcherVerifiedCommit, undefined);
    assert.equal(launchUrl(environment), null);
    assert.equal(h.remote.mainSha, "base-sha");
    assert.deepEqual((await h.source.state()).environments, []);
  });
}

for (const failure of ["missing published guide", "invalid published hash", "inherited runtime mismatch"]) {
  test(`${failure} cannot satisfy the inherited-runtime readiness gate`, async (t) => {
    const h = await harness(t);
    h.source.api = async (method, path, body) => {
      const result = await h.api(method, path, body);
      if (path === `repos/${TEMPLATE}/contents/.github/extensions/demo-launcher?ref=${h.remote.templateSha}`) {
        if (failure === "missing published guide") return result.filter(({ path }) => !path.endsWith("/BOOTSTRAP.md"));
        if (failure === "invalid published hash") result[0].sha = "";
      }
      if (failure === "inherited runtime mismatch" && path.includes("/contents/.github/extensions/demo-launcher?ref=base-sha")) {
        result[0].sha = "a".repeat(40);
      }
      return result;
    };
    await assert.rejects(h.create(), /verification failed/);
    const environment = await h.current();
    assert.equal(environment.launcherReady, undefined);
    assert.equal(launchUrl(environment), null);
    assert.equal(h.calls.filter(({ path }) => path.endsWith("/merges")).length, 0);
  });
}

test("a lost runtime readback can be retried without any new remote writes", async (t) => {
  const h = await harness(t);
  h.source.api = async (method, path, body) => {
    const result = await h.api(method, path, body);
    if (method === "GET" && path.includes("/contents/.github/extensions/demo-launcher?ref=base-sha")) throw new Error("Lost runtime response");
    return result;
  };
  await assert.rejects(h.create(), /Lost runtime response/);
  const writes = h.calls.filter(({ method }) => method !== "GET").length;
  const state = await h.store.read();
  await verifyLauncher(state.environments[0], { api: h.api, save: () => h.store.write(state) });
  assert.equal((await h.current()).launcherReady, true);
  assert.equal(h.calls.filter(({ method }) => method !== "GET").length, writes);
});

for (const repo of SOURCE_REPOSITORIES) {
  test(`${repo} can never be treated as a disposable canvas instance`, async () => {
    const environment = { id: "source-attempt", repo, defaultBranch: "main" };
    const calls = [];
    const api = async (method, path) => {
      calls.push({ method, path });
      return { full_name: repo, description: `Disposable Copilot demo [${environment.id}]`, private: false, fork: false };
    };
    await assert.rejects(verifyLauncher(environment, { api, save: async () => {} }), /identity/);
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

test("a changed demo default branch cannot redirect runtime verification", async (t) => {
  const h = await harness(t);
  h.source.api = async (method, path, body) => {
    const result = await h.api(method, path, body);
    if (method === "GET" && path.includes("/contents/.github/extensions/demo-launcher?ref=base-sha")) {
      h.remote.repository.default_branch = "demo/copilot-autofix";
    }
    return result;
  };
  await assert.rejects(h.create(), /default branch changed/);
  assert.equal(h.calls.filter(({ path }) => path.endsWith("/merges")).length, 0);
});

for (const failure of ["missing file", "missing bootstrap guide", "wrong contents", "symlink", "permission error"]) {
  test(`launcher readback rejects ${failure} instead of advertising a ready canvas`, async (t) => {
    const h = await harness(t);
    h.source.api = async (method, path, body) => {
      const result = await h.api(method, path, body);
      if (!path.includes("/contents/.github/extensions/demo-launcher?ref=base-sha")) return result;
      if (failure === "permission error") throw new GitHubError("Forbidden to read published files", 403);
      if (failure === "missing file") return result.slice(1);
      if (failure === "missing bootstrap guide") return result.filter(({ path }) => !path.endsWith("/BOOTSTRAP.md"));
      if (failure === "wrong contents") result[0].sha = "not-the-uploaded-file";
      if (failure === "symlink") result[0].type = "symlink";
      return result;
    };
    await assert.rejects(h.create(), /verification failed|Forbidden to read/);
    const environment = await h.current();
    assert.equal(environment.launcherReady, undefined);
    assert.equal(environment.step, "Verifying the published template canvas");
    const demo = await h.makeController(environment.repo).state();
    assert.equal(demo.environments[0].launchUrl, null);
    assert.equal(demo.environments[0].setupUrl, undefined);
    assert.deepEqual((await h.source.state()).environments, []);
    assert.equal(h.messages.length, 0);
  });
}

test("launcher readback rejects a branch that moved before launch", async (t) => {
  const h = await harness(t);
  h.source.api = async (method, path, body) => {
    const result = await h.api(method, path, body);
    if (method === "GET" && path.includes("/contents/.github/extensions/demo-launcher?ref=base-sha")) h.remote.mainSha = "changed-main";
    return result;
  };
  await assert.rejects(h.create(), /default branch changed during canvas verification/);
  assert.equal((await h.current()).launcherReady, undefined);
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
