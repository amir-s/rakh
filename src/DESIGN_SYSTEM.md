# Design System

## Goals
- Single canonical token contract
- Reusable primitive component API
- Low-drift migration for workspace/settings/new-session/tool surfaces
- One showcase page for visual QA and regression checks

## Files
- Tokens and themes: [`src/styles/tokens.css`](/Users/amir/.codex/worktrees/8f50/eve/src/styles/tokens.css), [`src/styles/themes/registry.ts`](/Users/amir/.codex/worktrees/8f50/eve/src/styles/themes/registry.ts)
- Primitive components: [`src/components/ui/index.ts`](/Users/amir/.codex/worktrees/8f50/eve/src/components/ui/index.ts)
- Primitive styles: [`src/styles/components-ui.css`](/Users/amir/.codex/worktrees/8f50/eve/src/styles/components-ui.css)
- Showcase page: [`src/ThemePreview.tsx`](/Users/amir/.codex/worktrees/8f50/eve/src/ThemePreview.tsx)

## Primitive APIs
- `Button`
- Props: `variant` (`primary|secondary|ghost|danger`), `size` (`xxs|xs|sm|md`), `loading`, `fullWidth`
- `IconButton`
- Compact icon-only action button
- `Badge`
- Props: `variant` (`primary|success|warning|info|danger|muted`)
- `StatusDot`
- Props: `status` (`idle|thinking|working|done|error`)
- `Panel`
- Props: `variant` (`default|inset|elevated`)
- `ModalShell`
- Shared modal container shell
- `TextField`
- Input with optional `startAdornment` / `endAdornment`
- `TextareaField`
- Textarea wrapped in shared field chrome
- `SelectField`
- Shared select styling
- `ToggleSwitch`
- Boolean switch
- `SegmentedControl<T extends string>`
- Typed segmented options + selected value

## Migration rules
- Prefer primitives for all controls (buttons, fields, toggles, selects, segmented controls)
- Keep feature-specific layout classes, but move control visuals/variants to primitives
- Avoid inline styles unless values are runtime-calculated (position, size, transform)
- Use canonical token names only (`--color-*`, `--font-mono`, `--color-term-bg`)

## Showcase (`?preview=true`)
The showcase validates:
- Button variants + disabled/loading
- Input/select/textarea states (default/focused/error/disabled)
- Toggle and segmented states (on/off/mixed)
- Badge and status dot states
- Message blocks: user, agent, streaming, reasoning collapsed/expanded
- Tool cards/rows: awaiting approval, running, done, denied, error
- Patch preview sample
- Neutral + error modal shells
- Top chrome + terminal status samples

Use it as the first visual check when changing tokens, primitive variants, or shared component styles.
