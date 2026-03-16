Rakh is a Tauri desktop application that embeds a React/Vite frontend and a
Rust backend. The agent runtime uses the Vercel AI SDK, per-tab Jotai state,
and a Tauri command layer for filesystem, shell, git, terminal, voice,
SQLite-backed session/artifact persistence, and JSON-backed todo storage.

## Canonical docs

- `docs/architecture.md` - system overview, runtime flow, and code map
- `docs/artifacts.md` - durable artifact model and validation flow
- `docs/subagents.md` - subagent registry, contracts, and execution model
- `src/DESIGN_SYSTEM.md` - UI primitives and token rules
- `src/THEMING.md` - theme/token implementation notes

## Common commands

Frontend and desktop commands live in `package.json`:

```bash
npm run dev
npm run build
npm run lint
npm run typecheck
npm run test
npm run test:all
npm run tauri:dev
npm run tauri:build
```

Rust tests live in module-level `#[cfg(test)]` blocks under `src-tauri/src/`:

```bash
cd src-tauri && cargo test
```

## Models and providers

- Provider instances are stored in IndexedDB via `src/agent/db.ts`.
- Settings supports `openai`, `anthropic`, and `openai-compatible` providers.
- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` can also be surfaced from the Rust
  backend through `load_provider_env_api_keys` for quick setup in Settings.
- The model picker is built from `src/agent/models.catalog.json` plus any
  cached `/models` response for openai-compatible providers.
- The runner resolves the selected model through `src/agent/modelCatalog.ts`
  and fails fast if the chosen entry has an empty `sdk_id`.

## Frontend structure

### App shell

- `src/App.tsx` - app bootstrap, session restore, theme application, autosave,
  notifications, and preview mode
- `src/WorkspacePage.tsx` - main split-pane workspace with chat, artifacts, and
  terminal
- `src/contexts/TabsContext.tsx` - tab strip state independent from agent state

### Agent runtime

- `src/agent/atoms.ts` - shared Jotai store and per-tab atom families
- `src/agent/mutationPolicy.ts` - tracked-mutation metadata validation and todo linkage rules
- `src/agent/useAgents.ts` - React hooks over per-tab agent state and actions
- `src/agent/runner.ts` - public runner facade: queue/run lifecycle,
  retry/stop helpers, and compatibility exports
- `src/agent/runner/*` - extracted runner internals: main/subagent loops,
  shared streaming/tool execution helpers, prompts, logging, MCP/worktree
  helpers, and leaf unit tests
- `src/agent/types.ts` - shared API/tool/state types
- `src/agent/persistence.ts` - frontend session snapshotting and restore helpers
- `src/agent/subagents/*` - built-in subagents and artifact contracts

### Tooling

- `src/agent/tools/workspace.ts` - list/stat/read/write/edit/glob/search
- `src/agent/tools/exec.ts` - command execution wrappers
- `src/agent/tools/git.ts` - `git_worktree_init`, which creates isolated
  worktrees through the backend `git_worktree_add` command
- `src/agent/tools/artifacts.ts` - durable artifact wrappers plus artifact
  change event subscription helpers
- `src/agent/tools/agentControl.ts` - title and agent control tools
- `src/agent/tools/todos.ts` - JSON-backed todo store wrappers and mutation tracking helpers
- `src/agent/tools/definitions.ts` - tool schemas exposed to the model
- `src/agent/tools/index.ts` - central dispatch for non-intercepted tools

### UI components

- `src/components/ArtifactPane.tsx` and `src/components/artifact-pane/*` -
  plans, todos, review diffs, git, debug, and durable artifact views; session
  inventory now refreshes via Tauri `artifact_changed` events instead of timer
  polling
- `src/components/Terminal.tsx` - xterm.js terminal backed by Tauri PTY
- `src/components/ToolCallApproval.tsx` / `src/components/UserInputCard.tsx` -
  approval and user-input surfaces
- `src/components/diffSerialization.ts` - opaque `SerializedDiff` wrapper used
  for persisted diff data

## Backend structure

`src-tauri/src/lib.rs` wires the app together and registers Tauri commands from
the backend modules:

- `src-tauri/src/db.rs` - sessions, archived sessions, artifacts, blob storage,
  provider env keys, and `artifact_changed` event emission after artifact
  writes
- `src-tauri/src/fs_ops.rs` - file and search operations
- `src-tauri/src/exec.rs` - non-interactive command execution plus abort/stop
- `src-tauri/src/pty.rs` - PTY lifecycle for the integrated terminal
- `src-tauri/src/git.rs` - worktree creation
- `src-tauri/src/todos.rs` - JSON-backed session todo store and mutation tracking
- `src-tauri/src/whisper.rs` - Whisper model prep and WAV transcription
- `src-tauri/src/shell_env.rs` / `src-tauri/src/utils.rs` - shared helpers

## State and persistence

Each workspace tab gets isolated `AgentState` through `atomFamily(tabId)`.
Important persisted fields include config, chat/API history, plan, todos,
review edits, tab title, worktree metadata, advanced model options, and debug
state.

`chatMessages` and `apiMessages` now serve different purposes:

- `chatMessages` are the durable visible transcript shown in the workspace UI
- `apiMessages` are the live model-facing history used for the next model call

Storage locations:

- providers: IndexedDB (`rakh-providers`)
- sessions and artifact manifests: `~/.rakh/sessions/sessions.db`
- session todos: `~/.rakh/sessions/todos/<sessionId>.json`
- artifact blobs: `~/.rakh/artifacts/blobs/sha256`
- agent-created worktrees: `~/.rakh/worktrees/<owner>/<repo>/<branch>`
- UI preferences such as theme and selected model: localStorage

Session rows no longer persist todo state. The JSON file is the source of truth
for todos.

`App.tsx` restores non-archived sessions on startup. `AutoSaveManager` persists
workspace tabs when they settle (`idle`, `done`, `error`) and archives closed
tabs unless the session is still empty.

### Adding new persisted state

If you add a new `AgentState` field that must survive restarts, update all of:

1. `src/agent/persistence.ts`
2. the restore path in `src/App.tsx`
3. `PersistedSession` and DB schema/load/save code in `src-tauri/src/db.rs`

## Tooling and path conventions

- Workspace tool paths are always relative to `cwd`.
- Path validation rejects leading `/` and normalized `..` traversal.
- Frontend paths are POSIX-style even on Windows.
- Tool results use `{ ok: true, data } | { ok: false, error }`.
- Push-style frontend updates use the Tauri event API; artifact pane refreshes
  listen for `artifact_changed` and then refetch manifests for the affected
  session.
- Sensitive tools go through `src/agent/approvals.ts`.
- `workspace_writeFile` and `workspace_editFile` pre-compute original diffs so
  chat review cards and the review pane both show stable before/after state.

## Testing notes

Frontend tests live next to source files as `*.test.ts`.

Runner coverage is split between:

- `src/agent/runner.test.ts` - orchestration/integration coverage for the public
  runner facade
- `src/agent/runner/*.test.ts` - leaf unit coverage for extracted runner
  helpers such as provider options, prompt construction, and pure utilities

Current frontend mocking conventions:

- Tauri availability is simulated with `window.__TAURI_INTERNALS__`
- `@tauri-apps/api/core` and Jotai atoms are mocked with `vi.mock()`
- shared mock state usually lives in a plain `Record<string, MockState>`

Rust tests use `tempfile::tempdir()` and in-memory SQLite where appropriate.
