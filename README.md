# Tailspin Toys

Tailspin Toys is a crowdfunding platform for games with a developer theme. The project is a website for a fictional game crowd-funding company, built as a single [Astro](https://astro.build/) site (fully prerendered/static output) styled with [Tailwind CSS](https://tailwindcss.com/). Its data lives in a local SQLite database accessed through [Drizzle ORM](https://orm.drizzle.team/) and Node.js's built-in SQLite driver; pages query the database directly in frontmatter at build time, so there is no separate backend service.

## Architecture

- **Astro 7** — pages, layouts, components, and routing. `output: 'static'`, so the whole site is prerendered to HTML at build time.
- **Drizzle ORM + Node SQLite** — the data layer. The schema lives in `db/schema.ts`; data is seeded from `db/games.csv`. Migrations are managed with `drizzle-kit`.
- **Tailwind CSS v4** — styling via utility classes (dark theme).
- **Vitest** — unit tests for the data layer and pure transforms.
- **Playwright** — end-to-end tests run against the built static site.

Development commands are defined in `package.json`: npm runs Astro for the dev server, static build, and preview. The `predev` and `prebuild` npm hooks run the TypeScript database migration and seed tasks in `db/`, writing to the gitignored `tailspin.db` file.

## Using this template

This repository is a GitHub template. When you create a new repository from it, a one-time **Bootstrap template issues** workflow (`.github/workflows/bootstrap-issues.yml`) runs automatically on the first push to `main` and opens a set of starter issues describing suggested first features. Each issue is defined by a Markdown file in `.github/bootstrap-issues/` — the first heading becomes the issue title and the remaining content becomes the body — so you can edit, add, or remove files there to control which issues are created.

The workflow only runs on repositories created from the template (the `if: ${{ !github.event.repository.is_template }}` guard skips the template itself), and after creating the issues it removes itself and the `.github/bootstrap-issues/` folder in a cleanup commit so it never runs again.

## Copilot app demo launcher

Open this repository in GitHub Copilot app and ask **"Open the Copilot demos canvas"**. The project extension in [`.github/extensions/demo-launcher`](.github/extensions/demo-launcher/) detects the checkout's GitHub origin. In the reusable [GitHubEBCDemos/tailspin-toys](https://github.com/GitHubEBCDemos/tailspin-toys) template or the original [github-samples/tailspin-toys](https://github.com/github-samples/tailspin-toys) repository, it shows environment setup. In a recorded disposable instance, it shows these five demos and cleanup; unrelated repositories cannot create resources, run demos, or clean up another environment. Both source repositories are protected from automated canvas merges and cleanup.

| Demo | Button behavior |
| --- | --- |
| Build a basic feature | **Run feature demo** implements game-title search in the current demo session, without authorizing commits or a PR. |
| Copilot Autofix (GitHub Advanced Security) | **Open Copilot Autofix PR** opens the seeded security PR; **Check readiness** checks current CodeQL/Autofix results. |
| Issue to pull request | **Run issue demo** opens the seeded pagination issue in its own worktree session and dispatches implementation, verification, and a linked PR. |
| Review a buggy PR | **Request Copilot review** requests review of a seeded one-based pagination helper; **Check review** checks feedback for the current commit. |
| Fix failing CI | **Check CI** confirms a current unit-test failure, then **Fix failing CI** opens that PR in its own worktree session and dispatches diagnosis, repair, and a push to the existing PR branch. |

Select **Create**, wait for provisioning, then select **Open session**. Create shows a spinner and **Creating...** with progress text; it never opens a tab or starts a session automatically. Open session is the only launch action. The link remains available for this attempt so a canceled dialog can be retried. Any repository configuration/extensions review happens inside the new-session launch, without returning to this canvas for a second button. Create becomes available again after provisioning: every click starts a new environment, even if an earlier attempt failed or another demo has pending work. It never selects or resumes an older setup. Each environment gets a unique `tailspin-demo-<date>-<id>` name and an **internal** repository in [GitHubEBCDemos](https://github.com/GitHubEBCDemos), using the published default branch of [GitHubEBCDemos/tailspin-toys](https://github.com/GitHubEBCDemos/tailspin-toys). The [template-generation API](https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template) only accepts public/private visibility, so creation starts private, immediately sets internal visibility, and verifies it before configuring CodeQL or seeding fixtures. A failed or unconfirmed visibility update stops setup and leaves the failed attempt's receipt; there is no public fallback. Existing public demos and the public source template are not converted. The signed-in `gh` account is recorded as the creator, separately from the organization owner; creation never falls back to a personal repository. It enables JavaScript/TypeScript CodeQL default setup, waits for its setup validation, and seeds a pagination issue plus three independent PRs on `demo/copilot-autofix`, `demo/code-review`, and `demo/failing-ci`. The canvas and application files are inherited from the published template, never uploaded from the running worktree. Publish canvas changes to the template's `main` before creating demos. Setup does not create a `demo/launcher` branch, upload runtime files, or merge anything into the demo's default branch. It never changes either source repository or merges any demo PR. The isolated `demo-security/preview.mjs` fixture has no listening server and is not imported by the Astro website; never merge or deploy it. The review and CI helpers are also isolated from the website, each on its own PR branch.

**Open session** remains unavailable until every required runtime file on the demo's default branch matches the published template's Git blob hash, including the automatic-startup module. Setup records both template and demo commits and rechecks that the demo's default branch did not change during verification. Missing files, symlinks, permission failures, or mismatches report errors rather than uploading a replacement or launching early. The link uses the documented [new-session deep link](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links#open-sessions), `ghapp://session/new`, with the demo repository and default branch; these establish the new session's repository context. Confirm the app's new-session dialog and any [repository configuration trust approval](https://docs.github.com/en/copilot/reference/github-copilot-app-reference/repository-configuration#review-and-trust-the-configuration). The launcher cannot read or accept the app's trust state. Once the host loads the extension, it verifies the current checkout against its saved receipt read-only, then opens its registered canvas through the public SDK using `demo-session-panel`. An already-open project canvas is reused; source, unrecognized, cleanup, item branches, and unregistered sessions after a primary session has been recorded are not automatically opened. Automatic-opening failures appear in the extension log and session timeline. The host must enable and load extensions; repository code cannot override a session started with `requestExtensions: false`. The Open session link is retained only for this attempt and cleared on reload or the next Create. The repository's [Copilot app configuration](.github/github-app.yml) runs `npm ci` when the session is created. The instance canvas hides setup and enables its session-dependent buttons after registration. Demo messages use the documented extension `session.send` API, not a private host bridge or self-directed cross-session message.

**Session registration:** The short kickoff only focuses the canvas and registers the current app session. It reads the canvas's `get_state`, verifies that session with `get_session`, then supplies the verified repository, project ID, session ID, and name to `bind_session`. This enables session-dependent demo actions and records the session for confirmed cleanup. There is no separate startup guide, agent-side Git verification, fetch, extension rewrite, or automatic reload. An unavailable canvas is reported as a startup failure rather than repaired by the agent. Initial approval for a new repository and renewed approval after intentional canvas/configuration changes still apply. Offline tests enforce a kickoff of at most 350 characters, extension-owned read-only runtime verification, and delivery through the browser's app-launch URL; they do not run a real app session.

**Prerequisites:** Node.js 22.13+, Git, an authenticated [GitHub CLI](https://cli.github.com/) with permission to create private template repositories and change their visibility to internal in [GitHubEBCDemos](https://github.com/GitHubEBCDemos), [GitHub Code Security access for CodeQL on internal repositories](https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning), permission to administer code-scanning configuration, GitHub Actions enabled, and a Copilot app version with canvas extensions and project/session tools. Internal visibility requires an enterprise-owned organization and the applicable repository-creation/visibility policy. Keep [GitHubEBCDemos/tailspin-toys](https://github.com/GitHubEBCDemos/tailspin-toys) configured as a public template repository. The review button uses [`gh pr edit --add-reviewer @copilot`](https://github.blog/changelog/2026-03-11-request-copilot-code-review-from-github-cli/) and requires CLI 2.88+ plus an eligible Copilot plan/repository policy. Authenticate separately with `gh auth login --hostname github.com`; the extension never stores a token. Account or organization policy may block CodeQL, Autofix, or code review. Creating the environment can consume Actions minutes, review/agent requests can consume Copilot usage, and template bootstrap automation may create its normal starter issues.

Use **Check readiness** before presenting the security demo. The launcher distinguishes queued/failed scans, the expected [`js/reflected-xss`](https://codeql.github.com/codeql-query-help/javascript/js-reflected-xss/) alert, stale analysis, and a current Autofix suggestion in a GitHub security-bot PR review comment. It never treats an HTTP success, unrelated alert, or an old suggestion as readiness. [Copilot Autofix](https://docs.github.com/en/code-security/concepts/code-scanning/autofix-for-code-scanning) is asynchronous and not guaranteed to generate a fix; review the PR itself if the status only confirms the alert. The default-branch Autofix REST endpoint is deliberately not used for this PR-only demo.

Issue and CI buttons authorize their described commit/push operations only in the disposable repository, never a merge. They dispatch to item-specific sessions and leave the instance canvas in place; use the app's session cards to inspect that work. Their receipts confirm delivery, whereas the game-search receipt confirms implementation in the current session. Recorded session IDs/names support later cleanup. The CI demo starts with two failing assertions for partially filled pages; repair must preserve those tests and the existing workflow. **Check CI** reads the current PR head's workflow and confirms the unit-test step failed, rather than treating an unrelated setup failure as demo readiness. After repair, use it again to show the remote result. Copilot reviews are asynchronous and not guaranteed to identify a particular bug; the launcher does not automatically repeat a request for the same commit.

**Stateless launcher and instance storage:** The source canvas retains no selected environment, setup history, or cleanup status. Only the current creation's progress and its Open session link are exposed; after provisioning it is ready to create another independent instance, and reload clears the transient link. Instance lifecycle receipts are saved locally under `$COPILOT_HOME/extensions/demo-launcher/artifacts/environments.json` (default `~/.copilot/extensions/demo-launcher/artifacts/environments.json`), outside Git, so each instance can find its own demos and perform verified cleanup. They are selected by the instance's repository, not a global active selection. A creation failure shows feedback for that attempt and identifies any repository to check for leftover resources; it does not delete those resources or silently reuse them on the next Create. Failed-attempt receipts remain available for diagnostics, but are not displayed as source-canvas history. Repository IDs and per-environment markers prevent accidental adoption of another repository, and stale callbacks are rejected. After updating extension code, reload extensions or restart the app session; refreshing only the canvas does not reload backend modules. The core setup session must remain available for cleanup.

GitHub language detection can lag behind template creation. Within the current creation attempt, the launcher briefly retries CodeQL's specific “selected languages are not present” response. GitHub can also return a CodeQL setup-run URL before Actions makes the run readable: a 404 on that exact run is retried within the existing validation wait, without recreating the repository or resubmitting setup. The spinner stays active until validation succeeds and the configuration reports JavaScript/TypeScript; language readback can lag behind run completion. Each wait is bounded to 24 checks at five-second intervals and reports a timeout if readiness never arrives. Failed validation and other API errors, including permission failures and 404s on the configuration endpoint, still stop creation.

**Cleanup:** In the instance canvas, select **Clean up environment** and confirm the displayed repository and session names. This authorizes stopping those sessions and removing their uncommitted work. The instance hands cleanup back to its recorded core repository and session rather than deleting itself. A guarded tool checks the signed-in creating account and revalidates the disposable GitHub repository's ID, owner, and marker before deleting it; the core agent then verifies and deletes the confirmed app sessions. Existing personal demo receipts remain compatible and route back to the original source. No core repository, arbitrary local directory, or unconfirmed session is deleted. Repository deletion requires suitable GitHub credentials (classic/OAuth credentials may need the `delete_repo` scope). Failures keep the receipt and expose **Retry cleanup**; check the previous request before retrying. Saved demo state is cleared only after repository deletion and verified session-removal receipts. **Final manual step:** remove the local demo project in Copilot app. Project removal is not exposed by the app tools, so cleanup never claims local project files were removed.

The canvas is an isolated, dependency-free HTML/JavaScript surface, rather than part of the Astro/Tailwind site. Its neutral surfaces and blue accents use the app's documented theme tokens and follow live light/dark changes, falling back to the system theme outside the app. Its loopback server uses a random capability URL, same-origin JSON requests, no credential-bearing browser calls, and no remote scripts. Run `npm run test:demos` for offline context/provisioning/cleanup recovery tests, fixture lint/type checks and failing-then-passing Vitest runs in temporary directories, and Playwright browser/accessibility checks using fake GitHub/session adapters and an intercepted app-launch URL. These tests never create or delete remote resources or real app sessions; they require the existing project dependencies and Playwright Chromium installation. Live provisioning happens only after pressing **Create**; reviews, agent work, and confirmed cleanup require their own buttons.

## Getting started

Install dependencies once with Node.js 22.13 or later:

```bash
npm ci
npx playwright install chromium   # only needed to run the E2E tests
```

## Launch the site

```bash
npm run dev
```

`predev` migrates and seeds the local database first. Then navigate to the [website](http://localhost:4321) to see the site!

To preview a production build instead:

```bash
npm run build      # prebuild migrates + seeds, then builds the static site
npm run preview
```

## Database

The SQLite database is built from `db/games.csv` — there is no live data to migrate.

```bash
npm run db:generate   # generate a migration after editing db/schema.ts
npm run db:migrate    # apply migrations
npm run db:seed       # seed from games.csv (idempotent)
npm run db:setup      # migrate + seed (run automatically by predev/prebuild)
npm run db:export     # write the seeded catalog to db/catalog.json
```

> [!NOTE]
> Seeding is idempotent — it skips games that already exist (matched by title) rather than reconciling changed rows. CI always starts from a clean database, so it reflects `games.csv` exactly. Locally, if you edit or remove rows in `games.csv`, delete `tailspin.db` and re-run `npm run db:setup` to fully regenerate.

## Running tests

```bash
npm run test:unit   # Vitest unit tests (transforms + data-access helpers)
npm run test:e2e    # Playwright E2E tests (builds + previews the static site first)
```

## Linting

The frontend uses ESLint to enforce code quality across TypeScript and Astro files. Run it with:

```bash
npm run lint
```

ESLint is also run automatically in CI on pull requests to `main`.

## Type checking

The project runs on **TypeScript 7** (the native Go compiler, `tsgo`) for type checking, adopted side-by-side via the [`@typescript/native-preview`](https://www.npmjs.com/package/@typescript/native-preview) package. The classic `typescript` package is intentionally kept at v6 so ESLint + `typescript-eslint` and `astro check` keep working unchanged — TypeScript 7's programmatic API isn't ready for those tools yet.

```bash
npm run typecheck        # tsgo (TS 7) type-checks the pure TypeScript (db/, src/lib/, src/types/, configs, tests)
npm run typecheck:astro  # astro sync + astro check type-check .astro files (on the classic TypeScript package)
npm run typecheck:all    # both of the above
```

`tsgo` runs against [`tsconfig.tsgo.json`](tsconfig.tsgo.json), a scoped config that excludes `.astro` files (which the native compiler doesn't understand). Type checking runs automatically in CI on pull requests to `main`.

> [!NOTE]
> The native compiler is used only for type checking (`--noEmit`); the site is still built by `astro build` (Vite/esbuild). The classic `typescript` package stays on v6 until `typescript-eslint` and `@astrojs/check` support the native API (~TS 7.1); a Dependabot `ignore` in `.github/dependabot.yml` holds the classic `typescript@7` bump until then.

## License 

This project is licensed under the terms of the MIT open source license. Please refer to the [LICENSE](./LICENSE) for the full terms.

## Maintainers 

You can find the list of maintainers in [CODEOWNERS](./.github/CODEOWNERS).

## Support

This project is provided as-is, and may be updated over time. If you have questions, please open an issue.

## Disclaimer

This app is not intended for use in a production environment, nor is it built as an example of what a production app should look like.
