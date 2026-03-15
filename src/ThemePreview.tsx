import { useState } from "react";
import type { ToolCallDisplay } from "@/agent/types";
import AgentMessage from "@/components/AgentMessage";
import CompactToolCall from "@/components/CompactToolCall";
import PatchPreview from "@/components/PatchPreview";
import ReasoningThought from "@/components/ReasoningThought";
import ToolCallApproval from "@/components/ToolCallApproval";
import ChatControls from "@/components/ChatControls";
import BusyComposerTray from "@/components/BusyComposerTray";
import UserMessage from "@/components/UserMessage";
import type { DiffFile } from "@/components/DiffViewer";
import {
  Badge,
  Button,
  IconButton,
  ModalShell,
  Panel,
  SegmentedControl,
  SelectField,
  StatusDot,
  TextField,
  TextareaField,
  ToggleSwitch,
  type BadgeVariant,
} from "@/components/ui";
import {
  THEME_NAMES,
  formatThemeName,
  type ThemeName,
} from "@/styles/themes/registry";

const PATCH_SAMPLE_FILES: DiffFile[] = [
  {
    filename: "src/components/ui/Button.tsx",
    adds: 7,
    removes: 2,
    lines: [
      { lineNum: 1, type: "context", html: "import { cn } from \"@/utils/cn\";" },
      {
        lineNum: 12,
        type: "remove",
        html: "interface ButtonProps extends ButtonHTMLAttributes&lt;HTMLButtonElement&gt; {}",
      },
      {
        lineNum: 12,
        type: "add",
        html: "interface ButtonProps extends ButtonHTMLAttributes&lt;HTMLButtonElement&gt; {",
      },
      {
        lineNum: 13,
        type: "add",
        html: "  variant?: \"primary\" | \"secondary\" | \"ghost\" | \"danger\";",
      },
      {
        lineNum: 14,
        type: "add",
        html: "  loading?: boolean;",
      },
      {
        lineNum: 15,
        type: "add",
        html: "}",
      },
      {
        lineNum: 31,
        type: "add",
        html: "<button className={buttonClasses({ variant, size })}>",
      },
    ],
  },
  {
    filename: "src/styles/components-ui.css",
    adds: 4,
    removes: 1,
    lines: [
      {
        lineNum: 44,
        type: "context",
        html: ".ui-btn--danger { border-color: color-mix(in srgb, var(--color-error) 30%, transparent); }",
      },
      {
        lineNum: 53,
        type: "remove",
        html: ".ui-btn:disabled { opacity: 0.55; }",
      },
      {
        lineNum: 53,
        type: "add",
        html: ".ui-btn:disabled { opacity: 0.45; cursor: not-allowed; }",
      },
      {
        lineNum: 92,
        type: "add",
        html: ".ui-toggle--on { background: var(--color-primary); border-color: var(--color-primary); }",
      },
    ],
  },
];

const TOOL_AWAITING: ToolCallDisplay = {
  id: "preview-awaiting",
  tool: "exec_run",
  args: {
    command: "npm",
    args: ["run", "build"],
    cwd: "/workspace/eve",
    reason: "Validate build output before merge.",
  },
  status: "awaiting_approval",
};

const TOOL_RUNNING: ToolCallDisplay = {
  id: "preview-running",
  tool: "exec_run",
  args: {
    command: "npm",
    args: ["run", "test", "--", "--run"],
    cwd: "/workspace/eve",
  },
  streamingOutput:
    "$ npm run test -- --run\n✓ src/agent/useModels.test.ts (4)\n✓ src/agent/runner.test.ts (12)",
  status: "running",
};

const TOOL_DONE: ToolCallDisplay = {
  id: "preview-done",
  tool: "workspace_readFile",
  args: {
    path: "src/ThemePreview.tsx",
    range: { startLine: 1, endLine: 80 },
  },
  result: {
    ok: true,
    data: {
      path: "src/ThemePreview.tsx",
      lineCount: 320,
      truncated: false,
    },
  },
  status: "done",
};

const TOOL_DENIED: ToolCallDisplay = {
  id: "preview-denied",
  tool: "exec_run",
  args: {
    command: "git",
    args: ["push", "--force-with-lease"],
  },
  result: {
    ok: false,
    error: {
      code: "PERMISSION_DENIED",
      message: "Command denied by user.",
    },
  },
  status: "denied",
};

const TOOL_ERROR: ToolCallDisplay = {
  id: "preview-error",
  tool: "workspace_search",
  args: {
    rootDir: "src",
    pattern: "themeNameAtom",
  },
  result: {
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "No matches found.",
    },
  },
  status: "error",
};

const SEGMENT_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "auto", label: "Mixed" },
  { value: "on", label: "On" },
] as const;

const STATUS_VARIANTS: Array<{
  status: "idle" | "thinking" | "working" | "done" | "error";
  badgeVariant: "muted" | "primary" | "success" | "danger";
}> = [
  { status: "idle", badgeVariant: "muted" },
  { status: "thinking", badgeVariant: "primary" },
  { status: "working", badgeVariant: "primary" },
  { status: "done", badgeVariant: "success" },
  { status: "error", badgeVariant: "danger" },
];

const BADGE_VARIANTS: Array<{
  label: string;
  variant: BadgeVariant;
}> = [
  { label: "primary", variant: "primary" },
  { label: "success", variant: "success" },
  { label: "warning", variant: "warning" },
  { label: "info", variant: "info" },
  { label: "danger", variant: "danger" },
  { label: "muted", variant: "muted" },
];

const PREVIEW_QUEUE_ITEMS = [
  {
    id: "preview-queue-1",
    content: "Add the missing repro steps before you keep running.",
  },
  {
    id: "preview-queue-2",
    content: "After that, summarize only the UI changes for approval.",
  },
] as const;

export default function ThemePreview() {
  const [themeName, setThemeName] = useState<ThemeName>("rakh");
  const [themeMode, setThemeMode] = useState<"dark" | "light">("dark");
  const [toggleOn, setToggleOn] = useState(true);
  const [toggleOff, setToggleOff] = useState(false);
  const [segmentedValue, setSegmentedValue] = useState<(typeof SEGMENT_OPTIONS)[number]["value"]>("auto");

  return (
    <div className="ds-page">
      <div className="ds-shell" data-theme-name={themeName} data-theme={themeMode}>
        <header className="ds-toolbar">
          <div>
            <h1 className="ds-title">Design System Showcase</h1>
            <p className="ds-subtitle">
              Canonical primitives and composed UI states for workspace, tools, and chrome.
            </p>
          </div>

          <div className="ds-toolbar-controls">
            <label className="ds-control">
              <span className="ds-control-label">Theme</span>
              <SelectField
                value={themeName}
                onChange={(event) => setThemeName(event.target.value as ThemeName)}
              >
                {THEME_NAMES.map((theme) => (
                  <option key={theme} value={theme}>
                    {formatThemeName(theme)}
                  </option>
                ))}
              </SelectField>
            </label>

            <label className="ds-control">
              <span className="ds-control-label">Mode</span>
              <SegmentedControl<"dark" | "light">
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
                value={themeMode}
                onChange={setThemeMode}
              />
            </label>
          </div>
        </header>

        <div className="ds-grid">
          <section className="ds-section">
            <h2 className="ds-section-title">Buttons</h2>
            <div className="ds-row">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
            </div>
            <div className="ds-row">
              <Button variant="primary" disabled>
                Disabled
              </Button>
              <Button variant="secondary" loading>
                Loading
              </Button>
              <IconButton title="Settings">
                <span className="material-symbols-outlined text-base">settings</span>
              </IconButton>
            </div>
          </section>

          <section className="ds-section">
            <h2 className="ds-section-title">Inputs</h2>
            <div className="ds-fields-grid">
              <TextField placeholder="Default input" />
              <TextField placeholder="Focused input" wrapClassName="ds-field-focused" />
              <TextField value="Validation error" readOnly wrapClassName="ds-field-error" />
              <TextField value="Disabled value" disabled />
              <SelectField defaultValue="openai">
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </SelectField>
              <SelectField className="ds-select-error" defaultValue="custom">
                <option value="custom">Custom provider</option>
              </SelectField>
              <TextareaField rows={2} defaultValue="Multiline prompt input" />
              <TextareaField rows={2} defaultValue="Readonly state" disabled />
            </div>
          </section>

          <section className="ds-section">
            <h2 className="ds-section-title">Toggles & Segmented</h2>
            <div className="ds-toggle-grid">
              <div className="ds-toggle-item">
                <span className="ds-item-label">On</span>
                <ToggleSwitch checked={toggleOn} onChange={setToggleOn} />
              </div>
              <div className="ds-toggle-item">
                <span className="ds-item-label">Off</span>
                <ToggleSwitch checked={toggleOff} onChange={setToggleOff} />
              </div>
              <div className="ds-toggle-item">
                <span className="ds-item-label">Mixed</span>
                <ToggleSwitch checked={false} onChange={() => {}} className="ds-toggle-mixed" />
              </div>
            </div>
            <SegmentedControl<(typeof SEGMENT_OPTIONS)[number]["value"]>
              options={SEGMENT_OPTIONS.map((item) => ({ ...item }))}
              value={segmentedValue}
              onChange={setSegmentedValue}
            />
          </section>

          <section className="ds-section">
            <h2 className="ds-section-title">Badges & Status Dots</h2>
            <div className="ds-status-grid">
              {STATUS_VARIANTS.map((entry) => (
                <div key={entry.status} className="ds-status-item">
                  <StatusDot status={entry.status} />
                  <Badge variant={entry.badgeVariant}>{entry.status}</Badge>
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs uppercase tracking-[0.08em] text-muted">
              Badge variants
            </div>
            <div className="ds-status-grid mt-2">
              {BADGE_VARIANTS.map((entry) => (
                <div key={entry.variant} className="ds-status-item">
                  <Badge variant={entry.variant}>{entry.label}</Badge>
                </div>
              ))}
            </div>
          </section>

          <section className="ds-section ds-section--full">
            <h2 className="ds-section-title">Message Blocks</h2>
            <div className="ds-message-grid">
              <Panel variant="inset" className="ds-message-panel">
                <UserMessage>
                  Please unify the design system and keep visual drift minimal.
                </UserMessage>
              </Panel>

              <Panel variant="inset" className="ds-message-panel">
                <AgentMessage badge="PLAN READY">
                  Migration complete for token contract and reusable primitives.
                </AgentMessage>
              </Panel>

              <Panel variant="inset" className="ds-message-panel">
                <AgentMessage streaming badge="WORKING">
                  Applying updates to settings and tool surfaces
                  <span className="animate-blink ml-1">◍</span>
                </AgentMessage>
              </Panel>

              <Panel variant="inset" className="ds-message-panel">
                <AgentMessage badge="REASONING">
                  <ReasoningThought
                    messageId="preview-reasoning-collapsed"
                    reasoning="Analyze duplicated control styles, normalize token names, and map one-off inputs to primitives."
                    expanded={false}
                    onToggle={() => {}}
                  />
                  <ReasoningThought
                    messageId="preview-reasoning-expanded"
                    reasoning="Migration strategy: first establish token registry and typed theme atoms, then replace duplicated controls with primitives, then validate no legacy tokens remain via grep acceptance checks."
                    expanded
                    onToggle={() => {}}
                  />
                </AgentMessage>
              </Panel>
            </div>
          </section>

          <section className="ds-section ds-section--full">
            <h2 className="ds-section-title">Tool Rows & Cards</h2>
            <div className="ds-tool-grid">
              <Panel variant="inset" className="ds-tool-panel">
                <h3 className="ds-item-label">Awaiting approval</h3>
                <ToolCallApproval toolCall={TOOL_AWAITING} tabId="preview-tab" />
              </Panel>

              <Panel variant="inset" className="ds-tool-panel">
                <h3 className="ds-item-label">Running</h3>
                <ToolCallApproval toolCall={TOOL_RUNNING} tabId="preview-tab" />
              </Panel>

              <Panel variant="inset" className="ds-tool-panel">
                <h3 className="ds-item-label">Done</h3>
                <CompactToolCall tc={TOOL_DONE} onInspect={() => {}} showDebug cwd="src" />
              </Panel>

              <Panel variant="inset" className="ds-tool-panel">
                <h3 className="ds-item-label">Denied</h3>
                <CompactToolCall tc={TOOL_DENIED} onInspect={() => {}} showDebug cwd="." />
              </Panel>

              <Panel variant="inset" className="ds-tool-panel">
                <h3 className="ds-item-label">Error</h3>
                <CompactToolCall tc={TOOL_ERROR} onInspect={() => {}} showDebug cwd="src" />
              </Panel>
            </div>
          </section>

          <section className="ds-section ds-section--full">
            <h2 className="ds-section-title">Composer States</h2>
            <div className="ds-tool-grid">
              <Panel variant="inset" className="ds-tool-panel">
                <h3 className="ds-item-label">Queued note</h3>
                <div className="chat-input-wrap ds-composer-preview">
                  <BusyComposerTray
                    queuedItems={[PREVIEW_QUEUE_ITEMS[0]]}
                    queueState="draining"
                    onSendQueuedNow={() => {}}
                    onRemoveQueuedItem={() => {}}
                  />
                  <ChatControls
                    autoApproveEdits={false}
                    autoApproveCommands="agent"
                    onChangeAutoApproveEdits={() => {}}
                    onChangeAutoApproveCommands={() => {}}
                    contextWindowPct={28}
                    contextCurrentTokens={7168}
                    contextCurrentKb={9.5}
                    contextMaxKb={32}
                    sessionUsageSummary={{
                      usage: {
                        inputTokens: 14200,
                        noCacheInputTokens: 14200,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        outputTokens: 3600,
                        reasoningTokens: 800,
                        totalTokens: 17800,
                      },
                      costStatus: "complete",
                      knownCostUsd: 0.096,
                      missingPricingModels: [],
                      breakdown: [
                        {
                          actorKind: "main",
                          actorId: "main",
                          actorLabel: "Rakh",
                          operationLabels: ["assistant turn"],
                          modelIds: ["openai/gpt-5.2"],
                          usage: {
                            inputTokens: 14200,
                            noCacheInputTokens: 14200,
                            cacheReadTokens: 0,
                            cacheWriteTokens: 0,
                            outputTokens: 3600,
                            reasoningTokens: 800,
                            totalTokens: 17800,
                          },
                          costStatus: "complete",
                          knownCostUsd: 0.096,
                        },
                      ],
                    }}
                  />
                  <div className="chat-input-shell">
                    <div className="ds-composer-draft ds-composer-draft--muted">
                      Type a message…
                    </div>
                    <div className="chat-input-actions">
                      <IconButton title="Voice input">
                        <span className="material-symbols-outlined text-lg">
                          mic
                        </span>
                      </IconButton>
                    </div>
                  </div>
                  <div className="chat-input-meta">
                    <span>Model: openai/gpt-5.2</span>
                    <span>•</span>
                    <span className="font-mono text-xs">/workspace/eve</span>
                  </div>
                </div>
              </Panel>

              <Panel variant="inset" className="ds-tool-panel">
                <h3 className="ds-item-label">Paused queue</h3>
                <div className="chat-input-wrap ds-composer-preview">
                  <BusyComposerTray
                    queuedItems={[...PREVIEW_QUEUE_ITEMS]}
                    queueState="paused"
                    onSendQueuedNow={() => {}}
                    onResumeQueue={() => {}}
                    onClearQueuedItems={() => {}}
                    onRemoveQueuedItem={() => {}}
                  />
                  <ChatControls
                    autoApproveEdits={true}
                    autoApproveCommands="no"
                    onChangeAutoApproveEdits={() => {}}
                    onChangeAutoApproveCommands={() => {}}
                    contextWindowPct={71}
                    contextCurrentTokens={19800}
                    contextCurrentKb={22.8}
                    contextMaxKb={32}
                    sessionUsageSummary={{
                      usage: {
                        inputTokens: 22800,
                        noCacheInputTokens: 22800,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        outputTokens: 6100,
                        reasoningTokens: 1400,
                        totalTokens: 28900,
                      },
                      costStatus: "partial",
                      knownCostUsd: 0.148,
                      missingPricingModels: [
                        {
                          modelId: "my-gateway/meta/llama-3.3-70b",
                          label: "Llama 3.3 70B",
                        },
                      ],
                      breakdown: [
                        {
                          actorKind: "main",
                          actorId: "main",
                          actorLabel: "Rakh",
                          operationLabels: ["assistant turn"],
                          modelIds: ["openai/gpt-5.2"],
                          usage: {
                            inputTokens: 16800,
                            noCacheInputTokens: 16800,
                            cacheReadTokens: 0,
                            cacheWriteTokens: 0,
                            outputTokens: 4900,
                            reasoningTokens: 1400,
                            totalTokens: 21700,
                          },
                          costStatus: "complete",
                          knownCostUsd: 0.148,
                        },
                        {
                          actorKind: "internal",
                          actorId: "context-compaction-summary",
                          actorLabel: "Context compaction",
                          operationLabels: ["artifact summary"],
                          modelIds: ["my-gateway/meta/llama-3.3-70b"],
                          usage: {
                            inputTokens: 6000,
                            noCacheInputTokens: 6000,
                            cacheReadTokens: 0,
                            cacheWriteTokens: 0,
                            outputTokens: 1200,
                            reasoningTokens: 0,
                            totalTokens: 7200,
                          },
                          costStatus: "missing",
                          knownCostUsd: 0,
                        },
                      ],
                    }}
                    onOpenProvidersSettings={() => {}}
                  />
                  <div className="chat-input-shell">
                    <div className="ds-composer-draft ds-composer-draft--muted">
                      Draft another follow-up while the agent is still working...
                    </div>
                    <div className="chat-input-actions">
                      <IconButton title="Voice input">
                        <span className="material-symbols-outlined text-lg">
                          mic
                        </span>
                      </IconButton>
                    </div>
                  </div>
                  <div className="chat-input-meta">
                    <span>Model: openai/gpt-5.2</span>
                    <span>•</span>
                    <span className="font-mono text-xs">/workspace/eve</span>
                  </div>
                </div>
              </Panel>
            </div>
          </section>

          <section className="ds-section ds-section--full">
            <h2 className="ds-section-title">Diff / Patch Preview</h2>
            <Panel variant="inset" className="ds-patch-panel">
              <PatchPreview files={PATCH_SAMPLE_FILES} />
            </Panel>
          </section>

          <section className="ds-section ds-section--full">
            <h2 className="ds-section-title">Modal Shells</h2>
            <div className="ds-modal-grid">
              <ModalShell>
                <div className="error-modal-header">
                  <span className="error-modal-title">
                    <span className="material-symbols-outlined text-md text-muted">info</span>
                    Neutral modal
                  </span>
                </div>
                <div className="error-modal-body">Settings changes have not been saved yet.</div>
                <div className="error-modal-footer">
                  <Button variant="ghost" size="xxs">
                    Cancel
                  </Button>
                  <Button variant="primary" size="xxs">
                    Save
                  </Button>
                </div>
              </ModalShell>

              <ModalShell className="error-modal">
                <div className="error-modal-header">
                  <span className="error-modal-title">
                    <span className="material-symbols-outlined text-md text-error">error</span>
                    Error modal
                  </span>
                </div>
                <pre className="error-modal-body">{"{\"code\":\"CONFLICT\",\"message\":\"Session changed on disk\"}"}</pre>
                <div className="error-modal-footer">
                  <Button variant="ghost" size="xxs">
                    Copy
                  </Button>
                  <Button variant="danger" size="xxs">
                    Dismiss
                  </Button>
                </div>
              </ModalShell>
            </div>
          </section>

          <section className="ds-section ds-section--full">
            <h2 className="ds-section-title">Top Chrome & Terminal</h2>
            <Panel variant="inset" className="ds-chrome-panel">
              <div className="top-chrome ds-top-chrome-sample" data-focused="true">
                <div className="traffic-light-spacer" />
                <div className="tab-list">
                  <div className="tab">
                    <div className="tab-dot tab-dot--idle" />
                    <span className="tab-label">README.md</span>
                  </div>
                  <div className="tab tab--active">
                    <div className="tab-dot tab-dot--working" />
                    <span className="tab-label">WorkspacePage.tsx</span>
                  </div>
                  <div className="tab">
                    <div className="tab-dot tab-dot--error" />
                    <span className="tab-label">runner.test.ts</span>
                  </div>
                </div>
              </div>

              <div className="terminal-full ds-terminal-sample">
                <div className="terminal-bar">
                  <div className="terminal-bar-title">
                    <span className="material-symbols-outlined text-base">terminal</span>
                    TERMINAL
                    <span className="terminal-bar-sep">•</span>
                    <span className="terminal-bar-path">/workspace/eve</span>
                  </div>
                  <div className="terminal-bar-right">
                    <span className="terminal-status-dot" />
                    <span className="terminal-bar-status">SYSTEM READY</span>
                  </div>
                </div>
                <div className="terminal-output ds-terminal-output-sample">
                  $ npm run typecheck
                  <br />
                  ✓ Type check passed in 2.2s
                </div>
              </div>
            </Panel>
          </section>
        </div>
      </div>
    </div>
  );
}
