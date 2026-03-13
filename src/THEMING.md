# Theming Guide

## Source of truth
- Canonical tokens live in [`src/styles/tokens.css`](/Users/amir/.codex/worktrees/8f50/eve/src/styles/tokens.css).
- Theme name registry lives in [`src/styles/themes/registry.ts`](/Users/amir/.codex/worktrees/8f50/eve/src/styles/themes/registry.ts).
- Theme state lives in [`themeModeAtom` and `themeNameAtom`](/Users/amir/.codex/worktrees/8f50/eve/src/agent/atoms.ts).

## Token contract (canonical)
- Background scale: `--color-window`, `--color-surface`, `--color-inset`, `--color-elevated`, `--color-subtle`, `--color-hover`
- Text: `--color-text`, `--color-muted`, `--color-faint`
- Accent and semantic: `--color-primary`, `--color-primary-dim`, `--color-primary-border`, `--color-success`, `--color-info`, `--color-error`, `--color-warning`, `--color-accent`
- Borders: `--color-border-subtle`, `--color-border-mid`
- Status dots: `--color-status-idle`, `--color-status-thinking`, `--color-status-working`, `--color-status-done`, `--color-status-error`
- Syntax: `--color-syn-*`
- Scrollbar: `--color-sb-*`
- Terminal: `--color-term-bg`
- Subagent accents: runtime-generated `--color-subagent-<id>` variables (derived from `src/agent/subagents/*`)
- Typography/motion: `--font-mono`, `--text-*`, `--t-fast`, `--t-base`, `--t-slow`

Legacy aliases are not part of the public contract anymore.

## Theme state model
- `themeModeAtom`: `"dark" | "light"`
- `themeNameAtom`: `ThemeName`
- Invalid stored theme names are coerced to `"rakh"` via `coerceThemeName`.

`App` applies both attributes on `<html>`:
- `data-theme="dark|light"`
- `data-theme-name="<theme>"`
- Runtime subagent color variables for every registered subagent ID (e.g. `--color-subagent-planner`) are also applied on `<html>` based on the current mode.

## Adding a theme
1. Add a CSS file in `src/styles/themes/<name>.css` with `[data-theme-name="<name>"]` and optional `[data-theme-name="<name>"][data-theme="light"]` overrides.
2. Add `<name>` to `THEME_NAMES` in [`registry.ts`](/Users/amir/.codex/worktrees/8f50/eve/src/styles/themes/registry.ts).
3. Import the new CSS file in [`tokens.css`](/Users/amir/.codex/worktrees/8f50/eve/src/styles/tokens.css).

## Preview and validation
- Open `?preview=true` to view the design-system showcase matrix.
- Use this to validate both mode switching and theme switching against canonical tokens.
