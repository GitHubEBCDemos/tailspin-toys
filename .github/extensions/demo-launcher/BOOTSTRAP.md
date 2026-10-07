# Demo canvas startup

Use the expected repository, default branch, and verified commit supplied in the kickoff. Do not guess these values. Read this guide from the pinned commit with `git show <verified-commit>:.github/extensions/demo-launcher/BOOTSTRAP.md`, not from an unverified working copy. If the commit is unavailable locally, verify the expected origin before fetching its supplied default branch.

## Verify the worktree

Operate only in this session's worktree, using absolute paths for shell commands. Verify its GitHub origin matches the expected repository and the verified commit belongs to `origin/<default-branch>`; fetch that branch from the verified origin if needed. The canvas is inherited from the published template. Demo creation does not upload extension files, create a launcher branch, or merge anything.

Check `.github/extensions/demo-launcher/extension.mjs` and its sibling runtime files, including this guide, against the verified commit. Do not restore, rewrite, or overwrite extension files, even if the directory is missing. Missing files, mismatches, local edits, tracked deletions, or symlinks must stop startup with their specific diagnostic. Changing repository-controlled extension content can invalidate the user's trust approval.

Do not switch branches, modify the main checkout, commit, push, install software, create another repository, or run a demo automatically.

## Use the existing provider

The launcher opens repository setup first. The user reviews and accepts its configuration/extensions there, then returns to the source canvas and selects Start demo session. That action is the user's confirmation, not a trust-state readback. Do not launch another session automatically or assume approval succeeded because a link was opened.

If `copilot-demos` is already declared in the session's canvas catalog, call `list_canvas_capabilities` and continue to opening and binding it. A successful capability read is the readiness check. Do not reload or require lifecycle tools for an available canvas. Zero lifecycle tools is not itself a canvas failure.

If the canvas is absent or unavailable, discover lifecycle tools with `api_tool.list_resources({"paths":["extensions_reload","extensions_manage"]})`. Use only the returned definitions. If `extensions_manage` is available, inspect `demo-launcher` for its status and log diagnostics. Only reload if the provider is unavailable and `extensions_reload` was actually discovered; make at most one recovery attempt, then use the refreshed canvas catalog.

If lifecycle tools are unavailable but the canvas becomes declared, use it rather than stopping for missing reload/inspection tools. If the canvas remains unavailable, report the actual discovery/capability/provider error and stop. Unaccepted repository configuration/extensions are one possible cause, not a proven diagnosis from missing tools alone.

When the app displays repository trust approval, the user must review and accept the configuration/extensions in the app UI, then resume startup or restart the session if its tool catalog has not refreshed. Never accept on their behalf or bypass the trust gate. Do not install another extension, create a replacement canvas, repeat reloads, or modify files to try to make tools appear.

## Open and bind the canvas

Use `list_canvas_capabilities` for `canvasId="copilot-demos"`, then `open_canvas` with that type and a stable caller-chosen `instanceId`. Read its `get_state` action and verify `context.repo` matches the expected repository and `context.kind="demo"`.

Use `get_session` with the returned `context.sessionId` to verify this session's repository and project. Call `bind_session` with the expected `repo` and the verified `projectId`, `sessionId`, and `sessionName`. Use the same canvas `instanceId` for actions, not its canvas type.

Read `get_state` again to confirm registration and leave the canvas open with the demo controls. Report verification or binding failures explicitly rather than claiming startup succeeded.
