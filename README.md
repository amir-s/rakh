<p align="center">
  <img alt="Rakh Logo" src="https://rakh.sh/icon-shadow.png?logo" />
</p>

# Rakh

Rakh is a desktop AI coding agent for local codebases. It combines a React/Vite
frontend with a Tauri/Rust backend to give you a multi-tab agent workspace with
tool approvals, git worktree isolation, an integrated terminal, durable
artifacts, and specialized subagents.

## Highlights

- Multiple independent agent tabs, each with isolated state and chat history
- OpenAI, Anthropic, and OpenAI-compatible provider support
- Safe file edits and shell commands through explicit approval gates
- Global MCP server registry in Settings, with per-run MCP tool discovery
- Automatic git worktree setup before agent-driven code changes
- Built-in subagents for planning, review, security, copy, and GitHub tasks
- Durable artifacts for plans, reports, and other structured outputs
- Structured JSONL logging with per-run traces and backend persistence
- Integrated terminal, voice input, theme system, and session restore

## Built with

- React 19 + Vite
- Tauri 2 + Rust
- Vercel AI SDK
- Jotai
- xterm.js
- Tailwind CSS 4

<p align="center">
  <img alt="Rakh Screenshot" src="https://rakh.sh/screenshot-rakh.png?shot" />
</p>

## Getting started

### Prerequisites

- Node.js 20+
- npm
- Rust toolchain
- Tauri system prerequisites for your platform

Install dependencies:

```bash
npm install
```

Run the web UI only:

```bash
npm run dev
```

Run the desktop app in development:

```bash
npm run tauri:dev
```

Structured logs are written by the desktop runtime to:

- release: `~/.rakh/logs/rakh.log`
- debug: `~/.rakh-dev/logs/rakh.log`

Example:

```bash
tail -f ~/.rakh/logs/rakh.log | grep '"tool-calls"'
```

## Provider setup

Rakh does not call model APIs until you configure a provider.

You can:

- add an OpenAI, Anthropic, or OpenAI-compatible provider in Settings
- import `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from your environment if they
  are already set

## MCP setup

Rakh can also discover tools from globally configured MCP servers.

In `Settings -> MCP Servers` you can:

- add stdio or streamable HTTP MCP server configs as JSON
- test discovery before saving
- enable `Save returned files as artifacts` if you want MCP-returned images or
  files to be stored in the artifact pane instead of being passed back into
  model context raw

The model picker is built from the static catalog in
`src/agent/models.catalog.json` plus any cached model list for
OpenAI-compatible providers.

## Using Rakh

1. Launch the app and open Settings if no provider is configured.
2. Add or import a provider.
3. Create a new session, choose a project folder, and pick a model.
4. Start chatting with the agent.
5. Approve edits, commands, or worktree creation when prompted.

Useful built-in slash commands:

- `/plan`
- `/review`
- `/security`
- `/copywrite`
- `/github`

## Development

Common commands:

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

Run Rust tests directly:

```bash
cd src-tauri && cargo test
```

## Docs

- `docs/artifacts.md` - durable artifact model and validation flow
- `docs/logging.md` - structured log schema, storage, query APIs, and CLI usage
- `docs/macos-release-signing.md` - Apple signing and notarization credentials for macOS releases
- `docs/subagents.md` - subagent registry, contracts, and execution model
- `docs/tauri-updater-release.md` - updater signing, GitHub secrets, and rollout checks
- `docs/windows-release-signing.md` - Windows code-signing options and credentials for releases
- `src/DESIGN_SYSTEM.md` - UI primitives and token rules
- `src/THEMING.md` - theme/token implementation notes

## Repository layout

- `src/` - React UI, agent runtime, tools, and styles
- `src-tauri/src/` - Rust commands and desktop integration
- `docs/` - artifact and subagent documentation
