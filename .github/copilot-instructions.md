# Tailspin Toys Crowd Funding Development Guidelines

This is a crowdfunding platform for games with a developer theme. The application is a single **Astro 7** site (fully prerendered/static output) styled with **Tailwind CSS v4**. Data is stored in a local SQLite database accessed at build time through **Drizzle ORM + Node.js's built-in SQLite driver**; pages query the database directly in frontmatter — there is no separate backend API or client-side UI framework. Please follow these guidelines when contributing:

## Agent notes

- Explore the project before beginning code generation
- Create todo lists for long operations
  - Before each step in a todo list, reread the instructions to ensure you always have the right directions
- Always use instructions files when available, reviewing before generating code
- Do not generate summary markdown files upon completion of a task
- Always use absolute paths when running scripts and BASH commands
- **NEVER commit or push to main automatically unless explicitly instructed to do so**

## Code standards

### Required Before Each Commit

#### Testing guidelines

- **Always run unit tests, lint, and type checks through the `quality-checks` skill.** The skill wraps `npm run test:unit`, `npm run lint`, and `npm run typecheck:all` with environment setup, ordering, and troubleshooting. Run the Playwright E2E suite directly with `npm run test:e2e`. (Starting the app for manual validation is not a quality check — run `npm run dev` directly for that.)
- Run Vitest unit tests to verify the data layer and transforms, and Playwright tests to verify e2e and frontend functionality
- Run ESLint to check frontend code quality before committing
- Review the existing tests to ensure we're not duplicating efforts
- Test code should be of the same quality as the rest of the project, and follow DRY principles
- For frontend changes, verify the build (`npm run build`) and run the end-to-end tests (`npm run test:e2e`) directly, to ensure everything works correctly
- When changing the data layer (schema, helpers, transforms), update and run the corresponding unit tests

#### Project guidelines

- When updating the database schema, generate and commit the drizzle-kit migration (`npm run db:generate`)
- When adding new functionality, make sure you update the README
- Make sure all guidance in the Copilot Instructions file is updated with any relevant changes, including to project structure and scripts, and programming guidance

### Code formatting requirements

- Use TypeScript with explicit types for function parameters and return values, especially in the data layer (`db/`, `src/lib/`)
- Frontend code (TypeScript, Astro) must pass ESLint checks (`npm run lint`)

### Data Layer Patterns (Drizzle + Node SQLite)

- Define tables in `db/schema.ts`; manage schema changes with drizzle-kit migrations - see `drizzle.instructions.md`
- Keep data-access helpers in `src/lib/` with an **injectable `db`** argument so they're testable
- Keep CSV/seed logic as pure functions in `db/transforms.ts`
- Seed-derived values must be deterministic (no `Math.random`) so static builds are reproducible

### Astro Patterns

- **Astro Pages/Components**: routing, layouts, content, and components are all `.astro` - see `astro.instructions.md`
- Query data directly in page frontmatter via the `src/lib/` helpers (build-time, static output)
- Dynamic routes use `getStaticPaths()` + `export const prerender = true`
- Provide a branded `404.astro` (unknown routes are real 404s under static output)
- Only add a scoped Astro `<script>` when genuine client interactivity is required

### Styling

- Use Tailwind CSS utility classes exclusively - see `style.instructions.md`
- Dark theme colors: slate palette (`bg-slate-800`, `text-slate-100`, etc.)
- Rounded corners and modern UI patterns
- Follow modern UI/UX principles with clean, accessible interfaces

### GitHub Actions workflows

- Follow good security practices
- Make sure to explicitly set the workflow permissions
- Add comments to document what tasks are being performed

## npm Commands

- Development commands are defined in `package.json`. They run Astro for the site and TypeScript tasks in `db/` for database setup.
- **Skills take precedence.** Before running a command directly, check whether a skill covers the task (e.g. the `quality-checks` skill wraps unit tests, lint, and type checks). If one applies, follow it.
- Key npm scripts:
  - `npm run dev` — start the Astro dev server (`predev` migrates + seeds the local SQLite database)
  - `npm run build` — build the static site (`prebuild` migrates + seeds the local SQLite database)
  - `npm run preview` — serve the built `dist/` output
  - `npm run lint` — ESLint
  - `npm run test:unit` — Vitest unit tests
  - `npm run test:demos` — five-scenario canvas provisioning/recovery, isolated fixture verification, and browser/accessibility tests using fake GitHub/session adapters; no remote mutations
  - `npm run test:e2e` — Playwright E2E tests (builds + previews first)
  - `npm run typecheck` — type-check the pure TypeScript with `tsgo` (TypeScript 7 native compiler, via `@typescript/native-preview`) using `tsconfig.tsgo.json`
  - `npm run typecheck:astro` — type-check `.astro` files with `astro check` (classic TypeScript package)
  - `npm run typecheck:all` — run both type-check scripts (used by the CI `type-check` job)
  - `npm run db:generate` / `db:migrate` / `db:seed` / `db:setup` — Drizzle schema/migration/seed tasks
  - `npm run db:export` — migrate and seed via `predb:export`, then write the catalog grounding file to `db/catalog.json`

> [!NOTE]
> TypeScript 7 (`tsgo`) is adopted **side-by-side** for type checking only; it does not affect linting. ESLint + `typescript-eslint` and `astro check` still resolve the classic `typescript` package (kept at v6) because the native compiler's API isn't ready for them yet. Do **not** bump the classic `typescript` package to 7 (a Dependabot `ignore` holds it) until `typescript-eslint` + `@astrojs/check` support the native API. `tsgo` is `--noEmit` only; the site is still built by `astro build`.

## Repository Structure

The application lives at the repository root:

- `db/`: Drizzle schema, migrations, transforms, seed, and `games.csv`
- `src/lib/`: Node SQLite client (`db.ts`) and data-access helpers (`games.ts`)
- `src/components/`: reusable `.astro` components
- `src/layouts/`: Astro layout templates
- `src/pages/`: Astro page routes (`index.astro` listing, `game/[id].astro`, `404.astro`, `about.astro`)
- `src/styles/`: CSS and Tailwind configuration
- `src/types/`: TypeScript interfaces (Game, Publisher, Category)
- `e2e-tests/`: Playwright E2E tests (home, games, accessibility)
- `drizzle.config.ts`, `vitest.config.ts`, `astro.config.mjs`, `playwright.config.ts`: tooling config
- `README.md`: Project documentation
- `.github/extensions/demo-launcher/`: Repository-aware, five-scenario Copilot app canvas. The core canvas is a stateless launcher: every Create provisions a fresh repository and shows current progress, without opening a tab or starting a session. Once verified, expose one Open session link using `ghapp://session/new` from the verified default branch. No separate repository-setup step or return trip is allowed. Keep the current attempt's link for canceled-dialog retries; clear it on reload or the next Create without restoring history. Never select or resume a previous environment from this canvas or block it on another demo's pending work. Keep lifecycle receipts for instance lookup, diagnostics, and confirmed cleanup, not source-canvas history. Verified instances show demos and confirmed cleanup. Inherit the canvas from the published template's default branch; do not upload worktree runtime files, create a launcher branch, or merge anything during setup. Publish source canvas changes only on explicit user authorization. Gate launch on every required inherited runtime blob matching the published template and a stable demo default-branch commit. After `joinSession`, `startup.mjs` verifies the recorded demo's origin, pinned ancestry, default-branch head, and regular runtime files before opening its registered canvas through the public SDK. Reuse an already-open project canvas. Do not auto-open source/unrecognized/cleanup/item sessions or unregistered sessions after a primary session is recorded. Use instance ID `demo-session-panel`, including in the kickoff, to avoid duplicate panels. Surface opening failures in logs and the session timeline. The host must load extensions; repository code cannot enable a host session with `requestExtensions: false`. Never accept trust on the user's behalf, claim a link proves approval, or use private bridges. The kickoff only focuses/opens the available canvas and binds the verified current app session; repository context comes from the session and canvas, not duplicated prompt metadata. Missing or changed extension files stop automatic startup; never restore or rewrite repository-controlled code to make tools appear. Scope receipts to the actual GitHub origin, not global active selection. Keep intentional security, logic-bug, and failing-test fixtures as text; materialize them only on isolated demo PR branches or temporary test directories. Game search runs in the current verified demo session; issue/CI work uses separate item worktrees with recorded app IDs/names. Cleanup delegates to the recorded core session, validates repository identity before remote deletion, verifies named session deletions before clearing state, and explicitly leaves local project removal to the user. Never delete local directories or use private app bridges. Validate with fake GitHub/session adapters and intercepted launch URLs, never live remote mutations or app-session deletion.

Keep fresh demo kickoff at most 350 characters: focus/open the canvas, read `get_state`, verify the current session with `get_session`, and call `bind_session` with its verified repository, project ID, session ID, and name. Do not add a bootstrap document, duplicated repository/commit metadata, agent-side Git checks or fetching, extension rewriting, or automatic reload recovery. If the canvas is unavailable, report the error and stop. Repository trust approval stays user-controlled and cannot be bypassed. Preserve extension-owned read-only validation, unavailable-provider errors, app-session binding, and the short kickoff's size limit in offline regression tests.

CodeQL setup must tolerate a newly returned setup-run URL temporarily returning HTTP 404 within its bounded validation wait, without resubmitting setup or creating another repository. Require successful run completion and configured JavaScript/TypeScript readback before seeding demo branches; never treat missing runs, empty language lists, timeouts, failed validation, or permission errors as readiness.

The reusable canvas template is [GitHubEBCDemos/tailspin-toys](https://github.com/GitHubEBCDemos/tailspin-toys). Both it and [github-samples/tailspin-toys](https://github.com/github-samples/tailspin-toys) are source contexts protected from automated canvas merges and deletion. Create always provisions internal instances in [GitHubEBCDemos](https://github.com/GitHubEBCDemos), never the signed-in user's namespace or a fallback owner. Use `gh repo create <generated-repo> --template GitHubEBCDemos/tailspin-toys --internal` directly; never create private/public first and PATCH visibility, clone locally, or push worktree files. Read back identity and internal visibility before CodeQL, fixtures, or launch. Stop on errors or unconfirmed visibility; never fall back to public. Record expected visibility in new receipts and enforce it in repository identity checks. Existing public receipts without visibility remain compatible; do not convert existing demos or the public source template. Internal CodeQL requires GitHub Code Security access. Record `createdBy` separately from the organization `owner`, and `sourceRepo` with `sourceSessionId` for accurate cleanup routing. Legacy personal receipts without these fields use their owner as creator and the original source repository. Find seeded issues by their unique receipt marker, not by an organization-valued creator filter.
