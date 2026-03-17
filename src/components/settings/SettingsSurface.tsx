import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Diagnostic } from "@codemirror/lint";
import {
  findNodeAtLocation,
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  a11yDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import pkg from "../../../package.json";
import {
  buildUniqueProviderName,
  type EnvKeyEntry,
  type EnvProviderType,
} from "@/agent/useEnvProviderKeys";
import {
  deleteProvider,
  mergeProviderCachedModels,
  normalizeProviderCachedModels,
  normalizeProviderModelRecord,
  saveProvider,
  type ProviderInstance,
  type ProviderModelCost,
  type ProviderModelLimit,
  type ProviderModelRecord,
  type CommunicationProfileRecord,
  type CommandListEntry,
  type MatchMode,
} from "@/agent/db";
import { rankFuzzyItems } from "@/utils/fuzzySearch";
import {
  saveMcpSettings,
  saveMcpServers,
  testMcpServer,
  type McpServerConfig,
  type McpServerProbeResult,
} from "@/agent/mcp";
import { logFrontendSoon } from "@/logging/client";
import { cn } from "@/utils/cn";
import {
  THEME_NAMES,
  formatThemeName,
  type ThemeName,
} from "@/styles/themes/registry";
import {
  Badge,
  Button,
  IconButton,
  ModalShell,
  Panel,
  SelectField,
  TextField,
  TextareaField,
  ToggleSwitch,
} from "@/components/ui";
import CopyableCodePill from "@/components/CopyableCodePill";
import JsonCodeEditor from "@/components/ui/JsonCodeEditor";
import {
  getAppUpdaterProgressValue,
  getAppUpdaterStatusLabel,
  getAppUpdaterStatusVariant,
} from "@/updater";
import {
  DEFAULT_SETTINGS_SECTION,
  getSettingsSectionBadge,
  getSettingsSectionDefinition,
  getSettingsSectionsForGroup,
  SETTINGS_SECTION_GROUPS,
  type SettingsSectionId,
} from "./model";
import type {
  SettingsControllerValue,
  VoiceDownloadStatus,
} from "./useSettingsController";

type TestStatus = "idle" | "testing" | "ok" | "error";
type ProviderRefreshStatus = "idle" | "loading" | "ok" | "error";
type McpProbeStatus = "idle" | "testing" | "ok" | "error";

const REFRESH_FEEDBACK_MS = 3000;
const MODELS_DEV_API_URL = "https://models.dev/api.json";

type ModelsDevStatus = "idle" | "loading" | "ready" | "error";

interface ModelsDevOffer {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  cost?: ProviderModelCost;
  limit?: ProviderModelLimit;
}

interface ModelsDevIndex {
  offersByModelId: Record<string, ModelsDevOffer[]>;
}

let modelsDevIndexCache: ModelsDevIndex | null = null;
let modelsDevIndexPromise: Promise<ModelsDevIndex> | null = null;

const MCP_SCHEMA_STDIO_EXAMPLE = `{
  // Shown in Settings.
  "name": "Filesystem",
  // true = discover tools on runs.
  "enabled": true,
  // Local command server.
  "transport": "stdio",
  // Executable to launch.
  "command": "npx",
  // Optional CLI args.
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  // Optional extra env.
  "env": {
    "NODE_ENV": "production"
  }
}`;

const MCP_SCHEMA_STREAMABLE_HTTP_EXAMPLE = `{
  // Shown in Settings.
  "name": "Remote MCP",
  // true = discover tools on runs.
  "enabled": true,
  // Remote HTTP server.
  "transport": "streamable-http",
  // Endpoint URL.
  "url": "https://example.com/mcp",
  // Optional request headers.
  "headers": {
    "Authorization": "Bearer <token>"
  },
  // Optional timeout in ms.
  "timeoutMs": 15000
}`;

const mcpStringMapSchema = z.record(z.string(), z.string());
const mcpStdioServerDraftSchema = z.object({
  id: z.string().trim().min(1, '"id" must not be empty.').optional(),
  name: z.string().trim().min(1, '"name" is required.'),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  transport: z.literal("stdio"),
  command: z.string().trim().min(1, '"command" is required for stdio servers.'),
  args: z.array(z.string()).optional(),
  env: mcpStringMapSchema.optional(),
});
const mcpStreamableHttpServerDraftSchema = z.object({
  id: z.string().trim().min(1, '"id" must not be empty.').optional(),
  name: z.string().trim().min(1, '"name" is required.'),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  transport: z.literal("streamable-http"),
  url: z
    .string()
    .trim()
    .min(1, '"url" is required for streamable-http servers.'),
  headers: mcpStringMapSchema.optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildModelsDevIndex(payload: unknown): ModelsDevIndex {
  if (!isRecord(payload)) {
    throw new Error("Invalid models.dev payload.");
  }

  const offersByModelId: Record<string, ModelsDevOffer[]> = {};

  for (const [providerKey, providerValue] of Object.entries(payload)) {
    if (!isRecord(providerValue)) continue;

    const providerId =
      typeof providerValue.id === "string" && providerValue.id.trim()
        ? providerValue.id.trim()
        : providerKey;
    const providerName =
      typeof providerValue.name === "string" && providerValue.name.trim()
        ? providerValue.name.trim()
        : providerId;
    const models = isRecord(providerValue.models) ? providerValue.models : null;
    if (!models) continue;

    for (const [modelKey, modelValue] of Object.entries(models)) {
      const modelRecord = normalizeProviderModelRecord({
        ...(isRecord(modelValue) ? modelValue : {}),
        id:
          isRecord(modelValue) &&
          typeof modelValue.id === "string" &&
          modelValue.id.trim()
            ? modelValue.id.trim()
            : modelKey,
      });
      if (!modelRecord) continue;

      const modelName =
        isRecord(modelValue) &&
        typeof modelValue.name === "string" &&
        modelValue.name.trim()
          ? modelValue.name.trim()
          : modelRecord.id;

      const offer: ModelsDevOffer = {
        key: `${providerId}:${modelRecord.id}`,
        providerId,
        providerName,
        modelId: modelRecord.id,
        modelName,
        ...(modelRecord.cost ? { cost: modelRecord.cost } : {}),
        ...(modelRecord.limit ? { limit: modelRecord.limit } : {}),
      };

      const existing = offersByModelId[modelRecord.id] ?? [];
      existing.push(offer);
      offersByModelId[modelRecord.id] = existing;
    }
  }

  for (const offers of Object.values(offersByModelId)) {
    offers.sort(
      (a, b) =>
        a.providerName.localeCompare(b.providerName) ||
        a.providerId.localeCompare(b.providerId),
    );
  }

  return { offersByModelId };
}

async function loadModelsDevIndex(): Promise<ModelsDevIndex> {
  if (modelsDevIndexCache) return modelsDevIndexCache;
  if (modelsDevIndexPromise) return modelsDevIndexPromise;

  modelsDevIndexPromise = fetch(MODELS_DEV_API_URL)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    })
    .then((payload) => {
      const index = buildModelsDevIndex(payload);
      modelsDevIndexCache = index;
      return index;
    })
    .catch((error) => {
      modelsDevIndexPromise = null;
      throw error;
    });

  return modelsDevIndexPromise;
}

function filterModelsDevOffers(
  offers: ModelsDevOffer[],
  query: string,
): ModelsDevOffer[] {
  return rankFuzzyItems(offers, query, (offer) => [
    offer.providerName,
    offer.providerId,
    offer.modelName,
    offer.modelId,
  ]).map((entry) => entry.item);
}
const mcpServerDraftSchema = z.discriminatedUnion("transport", [
  mcpStdioServerDraftSchema,
  mcpStreamableHttpServerDraftSchema,
]);

type McpServerDraftInput = z.output<typeof mcpServerDraftSchema>;

function formatMcpServerJson(server?: McpServerConfig): string {
  const template =
    server ??
    ({
      name: "Filesystem",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    } satisfies Omit<Extract<McpServerConfig, { transport: "stdio" }>, "id">);

  return JSON.stringify(template, null, 2);
}

function formatMcpServerIssue(issue: z.ZodIssue): string {
  if (issue.path.length === 0) return issue.message;
  return `${issue.path.join(".")}: ${issue.message}`;
}

function findMcpIssueNode(
  tree: JsonNode,
  path: readonly PropertyKey[],
): JsonNode {
  const jsonPath = path.filter(
    (segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number",
  );

  const exactNode =
    jsonPath.length > 0 ? findNodeAtLocation(tree, jsonPath) : tree;
  if (exactNode) return exactNode;

  const parentNode =
    jsonPath.length > 0
      ? findNodeAtLocation(tree, jsonPath.slice(0, -1))
      : undefined;
  return parentNode ?? tree;
}

function buildMcpServerDiagnostics(raw: string): Diagnostic[] {
  if (!raw.trim()) {
    return [
      {
        from: 0,
        to: 1,
        severity: "error",
        message: "Server JSON is required.",
      },
    ];
  }

  const parseErrors: ParseError[] = [];
  const tree = parseTree(raw, parseErrors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (parseErrors.length > 0 || !tree) {
    return parseErrors.map((error) => ({
      from: error.offset,
      to: error.offset + Math.max(error.length, 1),
      severity: "error",
      message: `Invalid JSON: ${printParseErrorCode(error.error)}.`,
    }));
  }

  const parsed = JSON.parse(raw) as unknown;
  const result = mcpServerDraftSchema.safeParse(parsed);
  if (result.success) return [];

  return result.error.issues.map((issue) => {
    const node = findMcpIssueNode(tree, issue.path);
    return {
      from: node.offset,
      to: node.offset + Math.max(node.length, 1),
      severity: "error",
      message: formatMcpServerIssue(issue),
    };
  });
}

function parseMcpServerJson(
  raw: string,
  fallbackId: string,
): { ok: true; data: McpServerConfig } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Server JSON is required." };
  }

  const diagnostics = buildMcpServerDiagnostics(trimmed);
  if (diagnostics.length > 0) {
    return {
      ok: false,
      error: diagnostics[0]?.message ?? "Server JSON is invalid.",
    };
  }

  const parsed = mcpServerDraftSchema.parse(
    JSON.parse(trimmed),
  ) as McpServerDraftInput;
  return {
    ok: true,
    data: {
      ...parsed,
      id: parsed.id?.trim() || fallbackId,
      enabled: parsed.enabled ?? true,
    },
  };
}

function McpSchemaHelpModal({
  themeMode,
  onClose,
}: {
  themeMode: "dark" | "light";
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label="MCP Server JSON Schema"
    >
      <ModalShell
        className="settings-schema-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-schema-modal__header">
          <div className="settings-schema-modal__title-wrap">
            <div className="settings-schema-modal__icon">
              <span className="material-symbols-outlined text-primary">
                help
              </span>
            </div>
            <div className="settings-schema-modal__heading">
              <p className="settings-schema-modal__eyebrow">MCP Settings</p>
              <h2 className="settings-schema-modal__title">
                MCP Server JSON Schema
              </h2>
              <p className="settings-schema-modal__subtitle">
                Paste one JSON object per server. Start with{" "}
                <code>transport</code>, then fill in the required keys for that
                transport.
              </p>
            </div>
          </div>
          <Button
            className="settings-schema-modal__close"
            type="button"
            variant="ghost"
            size="xxs"
            onClick={onClose}
            title="Close (Esc)"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </Button>
        </div>

        <div className="settings-schema-modal__content">
          <Panel variant="inset" className="settings-schema-intro">
            <p className="settings-schema-intro__text">
              Examples below use short comments for explanation only. Remove the
              comments before pasting into the editor.
            </p>
            <div className="settings-schema-rules">
              <span className="settings-schema-rule">One JSON object</span>
              <span className="settings-schema-rule">Pick one transport</span>
              <span className="settings-schema-rule">
                Remove comments before pasting
              </span>
            </div>
          </Panel>

          <div className="settings-schema-examples">
            <Panel variant="inset" className="settings-schema-example">
              <div className="settings-schema-example__header">
                <p className="settings-schema-example__title">Example: stdio</p>
                <Badge variant="primary">Local command</Badge>
              </div>
              <div className="settings-schema-example__code">
                <SyntaxHighlighter
                  language="javascript"
                  style={themeMode === "dark" ? a11yDark : oneLight}
                  customStyle={{
                    margin: 0,
                    padding: 0,
                    background: "transparent",
                    fontSize: "var(--text-xxs)",
                    lineHeight: 1.6,
                  }}
                  codeTagProps={{
                    style: {
                      fontFamily: "var(--font-mono)",
                    },
                  }}
                  wrapLongLines
                >
                  {MCP_SCHEMA_STDIO_EXAMPLE}
                </SyntaxHighlighter>
              </div>
            </Panel>
            <Panel variant="inset" className="settings-schema-example">
              <div className="settings-schema-example__header">
                <p className="settings-schema-example__title">
                  Example: streamable-http
                </p>
                <Badge variant="success">Remote endpoint</Badge>
              </div>
              <div className="settings-schema-example__code">
                <SyntaxHighlighter
                  language="javascript"
                  style={themeMode === "dark" ? a11yDark : oneLight}
                  customStyle={{
                    margin: 0,
                    padding: 0,
                    background: "transparent",
                    fontSize: "var(--text-xxs)",
                    lineHeight: 1.6,
                  }}
                  codeTagProps={{
                    style: {
                      fontFamily: "var(--font-mono)",
                    },
                  }}
                  wrapLongLines
                >
                  {MCP_SCHEMA_STREAMABLE_HTTP_EXAMPLE}
                </SyntaxHighlighter>
              </div>
            </Panel>
          </div>
        </div>

        <div className="settings-schema-modal__footer">
          <Button type="button" variant="secondary" size="xs" onClick={onClose}>
            Close
          </Button>
        </div>
      </ModalShell>
    </div>,
    document.body,
  );
}

async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderModelRecord[]> {
  const url = baseUrl.trim().replace(/\/+$/, "");
  if (!url) {
    throw new Error("Please enter a base URL first.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = apiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(`${url}/models`, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ id?: string; owned_by?: string }>;
  };

  return (json.data ?? [])
    .map((model) => model.id?.trim())
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, owned_by: "openai-compatible" }));
}

function formatNumberInput(value?: number): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "";
}

function parseOptionalNumberInput(
  value: string,
  { allowZero }: { allowZero: boolean },
): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return Number.NaN;
  if (allowZero ? parsed < 0 : parsed <= 0) return Number.NaN;
  return parsed;
}

interface ProviderModelDraft {
  id: string;
  name?: string;
  context: string;
  inputCost: string;
  outputCost: string;
}

function toProviderModelDraft(model: ProviderModelRecord): ProviderModelDraft {
  return {
    id: model.id,
    name: model.name,
    context: formatNumberInput(model.limit?.context),
    inputCost: formatNumberInput(model.cost?.input),
    outputCost: formatNumberInput(model.cost?.output),
  };
}

function toProviderModelRecord(
  draft: ProviderModelDraft,
): ProviderModelRecord | null {
  const id = draft.id.trim();
  if (!id) return null;

  const context = parseOptionalNumberInput(draft.context, { allowZero: false });
  const input = parseOptionalNumberInput(draft.inputCost, { allowZero: true });
  const output = parseOptionalNumberInput(draft.outputCost, {
    allowZero: true,
  });

  if (Number.isNaN(context) || Number.isNaN(input) || Number.isNaN(output)) {
    return null;
  }

  return {
    id,
    ...(draft.name?.trim() ? { name: draft.name.trim() } : {}),
    cost:
      input !== undefined || output !== undefined
        ? {
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {}),
          }
        : undefined,
    limit: context !== undefined ? { context } : undefined,
  };
}

function toProviderModelRecordLoose(
  draft: ProviderModelDraft,
): ProviderModelRecord | null {
  const strictRecord = toProviderModelRecord(draft);
  if (strictRecord) return strictRecord;

  const id = draft.id.trim();
  if (!id) return null;

  const context = parseOptionalNumberInput(draft.context, { allowZero: false });
  const input = parseOptionalNumberInput(draft.inputCost, { allowZero: true });
  const output = parseOptionalNumberInput(draft.outputCost, {
    allowZero: true,
  });

  return {
    id,
    ...(draft.name?.trim() ? { name: draft.name.trim() } : {}),
    cost:
      (!Number.isNaN(input) && input !== undefined) ||
      (!Number.isNaN(output) && output !== undefined)
        ? {
            ...(!Number.isNaN(input) && input !== undefined ? { input } : {}),
            ...(!Number.isNaN(output) && output !== undefined
              ? { output }
              : {}),
          }
        : undefined,
    limit:
      !Number.isNaN(context) && context !== undefined ? { context } : undefined,
  };
}

function formatPrefillPrice(cost?: ProviderModelCost): string {
  const parts: string[] = [];
  if (typeof cost?.input === "number" && Number.isFinite(cost.input)) {
    parts.push(`in $${cost.input}`);
  }
  if (typeof cost?.output === "number" && Number.isFinite(cost.output)) {
    parts.push(`out $${cost.output}`);
  }
  return parts.join(" · ");
}

function ModelsDevPrefill({
  modelId,
  modelsDevStatus,
  modelsDevError,
  offers,
  onApply,
}: {
  modelId: string;
  modelsDevStatus: ModelsDevStatus;
  modelsDevError: string | null;
  offers: ModelsDevOffer[];
  onApply: (offer: ModelsDevOffer) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filteredOffers = useMemo(
    () => filterModelsDevOffers(offers, query),
    [offers, query],
  );

  return (
    <div className="settings-provider-model-prefill">
      <div className="settings-provider-model-prefill__header">
        <Button
          type="button"
          variant="ghost"
          size="xxs"
          className="settings-provider-model-prefill__trigger"
          onClick={() => setOpen((current) => !current)}
          disabled={modelsDevStatus === "loading"}
          aria-expanded={open}
          aria-label={`Prefill ${modelId} metadata from models.dev`}
        >
          <span className="material-symbols-outlined text-sm">dataset</span>
          <span>Prefill</span>
          {modelsDevStatus === "ready" && offers.length > 0 ? (
            <>[{offers.length}]</>
          ) : null}
        </Button>
      </div>

      {open ? (
        <div className="settings-provider-model-prefill__panel">
          {modelsDevStatus === "error" ? (
            <div className="settings-provider-model-prefill__empty">
              {modelsDevError ?? "models.dev could not be loaded."}
            </div>
          ) : modelsDevStatus === "loading" ? (
            <div className="settings-provider-model-prefill__empty">
              Loading models.dev catalog…
            </div>
          ) : offers.length === 0 ? (
            <div className="settings-provider-model-prefill__empty">
              No providers on models.dev currently expose this model ID.
            </div>
          ) : (
            <>
              <TextField
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search provider…"
                aria-label={`Search models.dev providers for ${modelId}`}
                wrapClassName="settings-input-wrap"
              />
              <div className="settings-provider-model-prefill__list">
                {filteredOffers.length === 0 ? (
                  <div className="settings-provider-model-prefill__empty">
                    No providers match that search.
                  </div>
                ) : (
                  filteredOffers.map((offer) => {
                    const context =
                      typeof offer.limit?.context === "number"
                        ? `${offer.limit.context.toLocaleString()} ctx`
                        : "";
                    const price = formatPrefillPrice(offer.cost);

                    return (
                      <button
                        key={offer.key}
                        type="button"
                        className="settings-provider-model-prefill__option"
                        onClick={() => {
                          onApply(offer);
                          setOpen(false);
                          setQuery("");
                        }}
                      >
                        <div className="settings-provider-model-prefill__option-copy">
                          <span className="settings-provider-model-prefill__option-name">
                            {offer.providerName}
                          </span>
                          <span className="settings-provider-model-prefill__option-meta">
                            {offer.providerId}
                          </span>
                        </div>
                        <div className="settings-provider-model-prefill__option-chips">
                          {context ? (
                            <span className="settings-provider-model-prefill__chip">
                              {context}
                            </span>
                          ) : null}
                          {price ? (
                            <span className="settings-provider-model-prefill__chip">
                              {price}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatUpdaterLastChecked(lastCheckedAt: number | null): string {
  if (!lastCheckedAt) return "Automatic startup checks are enabled.";
  return `Last checked ${new Date(lastCheckedAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}.`;
}

function SectionCard({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Panel className="settings-card">
      <div className="settings-card__header">
        <div>
          <h3 className="settings-card__title">{title}</h3>
          {description ? (
            <p className="settings-card__description">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="settings-card__actions">{actions}</div>
        ) : null}
      </div>
      <div className="settings-card__body">{children}</div>
    </Panel>
  );
}

function ProviderConfigurator({
  provider,
  modelsDevStatus,
  modelsDevError,
  modelsDevOffersByModelId,
  onSave,
  onCancel,
}: {
  provider?: ProviderInstance;
  modelsDevStatus: ModelsDevStatus;
  modelsDevError: string | null;
  modelsDevOffersByModelId: Record<string, ModelsDevOffer[]>;
  onSave: (provider: ProviderInstance) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [type, setType] = useState<ProviderInstance["type"]>(
    provider?.type ?? "openai",
  );
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [keyVisible, setKeyVisible] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [cachedModels, setCachedModels] = useState<ProviderModelDraft[]>(() =>
    normalizeProviderCachedModels(provider?.cachedModels).map(
      toProviderModelDraft,
    ),
  );

  const isCustom = type === "openai-compatible";
  const hasCachedModels = cachedModels.length > 0;

  const buildCachedModelRecords = useCallback(() => {
    const nextModels = cachedModels.map(toProviderModelRecord);
    if (nextModels.some((model) => model === null)) {
      setSaveError(
        "Custom model metadata must be numeric. Context limit must be greater than 0 and costs cannot be negative.",
      );
      return null;
    }

    setSaveError(null);
    return nextModels.filter(
      (model): model is ProviderModelRecord => model !== null,
    );
  }, [cachedModels]);

  const updateCachedModelDraft = useCallback(
    (
      index: number,
      field: keyof Pick<
        ProviderModelDraft,
        "context" | "inputCost" | "outputCost"
      >,
      value: string,
    ) => {
      setSaveError(null);
      setCachedModels((currentModels) =>
        currentModels.map((currentModel, currentIndex) =>
          currentIndex === index
            ? {
                ...currentModel,
                [field]: value,
              }
            : currentModel,
        ),
      );
    },
    [],
  );

  const applyModelsDevOffer = useCallback(
    (index: number, offer: ModelsDevOffer) => {
      setSaveError(null);
      setCachedModels((currentModels) =>
        currentModels.map((currentModel, currentIndex) =>
          currentIndex === index
            ? {
                ...currentModel,
                context: formatNumberInput(offer.limit?.context),
                inputCost: formatNumberInput(offer.cost?.input),
                outputCost: formatNumberInput(offer.cost?.output),
              }
            : currentModel,
        ),
      );
    },
    [],
  );

  const handleTest = async () => {
    if (!isCustom) {
      setSaveError(null);
      setTestStatus("ok");
      return;
    }

    setTestStatus("testing");
    setTestError(null);
    try {
      const models = await fetchOpenAICompatibleModels(baseUrl, apiKey);
      setCachedModels((currentModels) =>
        mergeProviderCachedModels(
          currentModels
            .map(toProviderModelRecordLoose)
            .filter((model): model is ProviderModelRecord => model !== null),
          models,
        ).map(toProviderModelDraft),
      );
      setTestStatus("ok");
    } catch (error) {
      setTestStatus("error");
      setTestError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSaveClick = () => {
    if (!name.trim()) return;
    const nextCachedModels = isCustom ? buildCachedModelRecords() : undefined;
    if (isCustom && nextCachedModels === null) return;

    onSave({
      id: provider?.id ?? uuidv4(),
      name: name.trim(),
      type,
      apiKey: apiKey.trim(),
      baseUrl: isCustom ? baseUrl.trim() : undefined,
      cachedModels: nextCachedModels ?? undefined,
    });
  };

  return (
    <Panel className="settings-provider-form">
      <div className="settings-provider-form__grid">
        <div className="settings-field">
          <label className="settings-field-label" htmlFor="provider-name">
            Name
          </label>
          <TextField
            id="provider-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My OpenAI Key"
            wrapClassName="settings-input-wrap"
          />
        </div>

        <div className="settings-field">
          <label className="settings-field-label" htmlFor="provider-type">
            Provider Type
          </label>
          <SelectField
            id="provider-type"
            className="settings-input settings-provider-form__select"
            value={type}
            onChange={(e) =>
              setType(e.target.value as ProviderInstance["type"])
            }
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai-compatible">
              Custom (OpenAI Compatible)
            </option>
          </SelectField>
        </div>

        <div className="settings-field">
          <label className="settings-field-label" htmlFor="provider-api-key">
            {isCustom ? "API Key (optional)" : "API Key"}
          </label>
          <TextField
            id="provider-api-key"
            type={keyVisible ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            wrapClassName="settings-input-wrap"
            endAdornment={
              <IconButton
                className="settings-input-icon-btn"
                onClick={() => setKeyVisible((visible) => !visible)}
                title={keyVisible ? "Hide key" : "Show key"}
                type="button"
              >
                <span className="material-symbols-outlined text-md">
                  {keyVisible ? "visibility_off" : "visibility"}
                </span>
              </IconButton>
            }
          />
        </div>

        {isCustom ? (
          <div className="settings-field">
            <label className="settings-field-label" htmlFor="provider-base-url">
              Base URL (include version)
            </label>
            <TextField
              id="provider-base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              wrapClassName="settings-input-wrap"
            />
          </div>
        ) : null}
      </div>

      {isCustom ? (
        <div className="settings-provider-models">
          <div className="settings-provider-models__header">
            <div>
              <p className="settings-provider-models__title">Loaded models</p>
              <p className="settings-provider-models__description">
                Context and token cost metadata for each model is optional.
                <br />
                Recommended for accurate cost estimation and context management.
              </p>
            </div>
            <Badge variant={hasCachedModels ? "success" : "muted"}>
              {cachedModels.length} loaded
            </Badge>
          </div>

          {hasCachedModels ? (
            <div className="settings-provider-models__list">
              {cachedModels.map((model, index) => (
                <Panel
                  key={model.id}
                  variant="inset"
                  className="settings-provider-model"
                >
                  <div className="settings-provider-model__row">
                    <div className="settings-provider-model__copy">
                      <span className="settings-provider-model__name">
                        {model.name || model.id}
                      </span>
                      <span className="settings-provider-model__id">
                        {model.id}
                      </span>
                    </div>
                    <ModelsDevPrefill
                      modelId={model.id}
                      modelsDevStatus={modelsDevStatus}
                      modelsDevError={modelsDevError}
                      offers={modelsDevOffersByModelId[model.id] ?? []}
                      onApply={(offer) => applyModelsDevOffer(index, offer)}
                    />
                    <div className="settings-provider-model__meta-field settings-provider-model__meta-field--context">
                      <label
                        className="settings-provider-model__meta-label"
                        htmlFor={`provider-model-context-${index}`}
                      >
                        Context
                      </label>
                      <TextField
                        id={`provider-model-context-${index}`}
                        aria-label="Context limit"
                        type="number"
                        inputMode="numeric"
                        min="1"
                        step="1"
                        value={model.context}
                        onChange={(event) =>
                          updateCachedModelDraft(
                            index,
                            "context",
                            event.target.value,
                          )
                        }
                        placeholder="e.g. 128000"
                        wrapClassName="settings-input-wrap settings-provider-model__meta-input-wrap"
                      />
                    </div>

                    <div className="settings-provider-model__meta-field">
                      <label
                        className="settings-provider-model__meta-label"
                        htmlFor={`provider-model-input-cost-${index}`}
                      >
                        In / 1M
                      </label>
                      <TextField
                        id={`provider-model-input-cost-${index}`}
                        aria-label="Input cost / 1M"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.001"
                        value={model.inputCost}
                        onChange={(event) =>
                          updateCachedModelDraft(
                            index,
                            "inputCost",
                            event.target.value,
                          )
                        }
                        placeholder="e.g. 0.15"
                        wrapClassName="settings-input-wrap settings-provider-model__meta-input-wrap"
                      />
                    </div>

                    <div className="settings-provider-model__meta-field">
                      <label
                        className="settings-provider-model__meta-label"
                        htmlFor={`provider-model-output-cost-${index}`}
                      >
                        Out / 1M
                      </label>
                      <TextField
                        id={`provider-model-output-cost-${index}`}
                        aria-label="Output cost / 1M"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.001"
                        value={model.outputCost}
                        onChange={(event) =>
                          updateCachedModelDraft(
                            index,
                            "outputCost",
                            event.target.value,
                          )
                        }
                        placeholder="e.g. 0.60"
                        wrapClassName="settings-input-wrap settings-provider-model__meta-input-wrap"
                      />
                    </div>
                  </div>
                </Panel>
              ))}
            </div>
          ) : (
            <Panel variant="inset" className="settings-empty-panel">
              <span className="material-symbols-outlined settings-empty-panel__icon">
                database
              </span>
              <div className="settings-empty-panel__copy">
                <span className="settings-empty-panel__title">
                  No models loaded yet
                </span>
                <span className="settings-empty-panel__description">
                  Test the connection here or refresh the provider later to pull
                  the available `/models` list into local settings.
                </span>
              </div>
            </Panel>
          )}
        </div>
      ) : null}

      <div className="settings-provider-form__footer">
        <div className="settings-provider-form__status" aria-live="polite">
          {testStatus === "ok" ? (
            <span className="settings-feedback settings-feedback--success">
              <span className="material-symbols-outlined text-md">
                check_circle
              </span>
              {isCustom && hasCachedModels
                ? `${cachedModels.length} model${cachedModels.length === 1 ? "" : "s"} loaded.`
                : "Provider looks valid."}
            </span>
          ) : null}
          {saveError ? (
            <span className="settings-feedback settings-feedback--error">
              <span className="material-symbols-outlined text-md">error</span>
              {saveError}
            </span>
          ) : null}
          {testStatus === "error" && testError ? (
            <span className="settings-feedback settings-feedback--error">
              <span className="material-symbols-outlined text-md">error</span>
              {testError}
            </span>
          ) : null}
        </div>

        <div className="settings-provider-form__actions">
          <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => {
              void handleTest();
            }}
            loading={testStatus === "testing"}
          >
            Test
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={handleSaveClick}
            disabled={!name.trim()}
          >
            Save Provider
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function McpServerConfigurator({
  server,
  themeMode,
  onSave,
  onCancel,
}: {
  server?: McpServerConfig;
  themeMode: "dark" | "light";
  onSave: (server: McpServerConfig) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [serverId] = useState(() => server?.id ?? uuidv4());
  const [jsonInput, setJsonInput] = useState(() => formatMcpServerJson(server));
  const [showSchemaHelp, setShowSchemaHelp] = useState(false);
  const [probeStatus, setProbeStatus] = useState<McpProbeStatus>("idle");
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<McpServerProbeResult | null>(
    null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const liveValidation = parseMcpServerJson(jsonInput, serverId);

  const buildServerDraft = (): McpServerConfig | null => {
    if (!liveValidation.ok) {
      setSaveError(liveValidation.error);
      return null;
    }

    setSaveError(null);
    return liveValidation.data;
  };

  const handleTest = async () => {
    const nextServer = buildServerDraft();
    if (!nextServer) return;

    setProbeStatus("testing");
    setProbeError(null);
    setProbeResult(null);
    try {
      const result = await testMcpServer(nextServer);
      setProbeResult(result);
      setProbeStatus("ok");
    } catch (error) {
      setProbeStatus("error");
      setProbeError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSaveClick = () => {
    const nextServer = buildServerDraft();
    if (!nextServer) return;
    void onSave(nextServer);
  };

  return (
    <Panel className="settings-provider-form">
      <div className="settings-provider-form__grid">
        <div className="settings-field settings-field--full-span">
          <label className="settings-field-label">Server JSON</label>
          <div className="settings-input-wrap settings-json-editor-wrap">
            <JsonCodeEditor
              aria-label="Server JSON"
              value={jsonInput}
              onChange={(value) => {
                setJsonInput(value);
                setSaveError(null);
              }}
              themeMode={themeMode}
              placeholder="Paste one MCP server object as JSON."
              validate={buildMcpServerDiagnostics}
              className="settings-json-editor"
              minHeight="260px"
            />
          </div>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label settings-row-label-with-action">
            <span>JSON schema</span>
            <IconButton
              type="button"
              className="settings-inline-help-btn"
              aria-label="Open MCP JSON schema help"
              title="Open MCP JSON schema help"
              onClick={() => setShowSchemaHelp(true)}
            >
              <span className="material-symbols-outlined text-sm">
                help_outline
              </span>
            </IconButton>
          </div>
          <span className="settings-row-desc">
            Use the same object shape that is persisted to disk. Common fields
            are `name`, `enabled`, `transport`, and optional `timeoutMs`; `id`
            is optional when creating a new entry.
          </span>
        </div>
      </div>

      {probeResult ? (
        <Panel variant="inset" className="settings-callout">
          <div className="settings-callout__icon">
            <span className="material-symbols-outlined text-success text-[18px]">
              check_circle
            </span>
          </div>
          <div className="settings-callout__body">
            <p className="settings-callout__title">
              {probeResult.toolCount} tool
              {probeResult.toolCount === 1 ? "" : "s"} discovered
            </p>
            <p className="settings-callout__copy">
              {probeResult.tools.length > 0
                ? probeResult.tools
                    .slice(0, 6)
                    .map((tool) => tool.title ?? tool.name)
                    .join(", ")
                : "The server connected successfully but returned no tools."}
            </p>
          </div>
        </Panel>
      ) : null}

      <div className="settings-provider-form__footer">
        <div className="settings-provider-form__status" aria-live="polite">
          {probeStatus === "ok" && !probeResult ? (
            <span className="settings-feedback settings-feedback--success">
              <span className="material-symbols-outlined text-md">
                check_circle
              </span>
              Server connected successfully.
            </span>
          ) : null}
          {probeStatus === "error" && probeError ? (
            <span className="settings-feedback settings-feedback--error">
              <span className="material-symbols-outlined text-md">error</span>
              {probeError}
            </span>
          ) : null}
          {saveError ? (
            <span className="settings-feedback settings-feedback--error">
              <span className="material-symbols-outlined text-md">error</span>
              {saveError}
            </span>
          ) : !liveValidation.ok ? (
            <span className="settings-feedback settings-feedback--error">
              <span className="material-symbols-outlined text-md">error</span>
              {liveValidation.error}
            </span>
          ) : null}
        </div>

        <div className="settings-provider-form__actions">
          <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => {
              void handleTest();
            }}
            loading={probeStatus === "testing"}
          >
            Test
          </Button>
          <Button type="button" size="xs" onClick={handleSaveClick}>
            Save Server
          </Button>
        </div>
      </div>

      {showSchemaHelp ? (
        <McpSchemaHelpModal
          themeMode={themeMode}
          onClose={() => setShowSchemaHelp(false)}
        />
      ) : null}
    </Panel>
  );
}

function AppearanceSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  return (
    <div className="settings-page__section-stack">
      <SectionCard
        title="Theme & Mode"
        description="Choose the visual theme and whether the UI uses dark or light mode."
      >
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Theme</span>
            <span className="settings-row-desc">
              Theme palettes come from the design-token theme registry.
            </span>
          </div>
          <SelectField
            className="settings-select settings-select--compact"
            value={controller.themeName}
            onChange={(e) =>
              controller.setThemeName(e.target.value as ThemeName)
            }
          >
            {THEME_NAMES.map((themeName) => (
              <option key={themeName} value={themeName}>
                {formatThemeName(themeName)}
              </option>
            ))}
          </SelectField>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Mode</span>
            <span className="settings-row-desc">
              Toggle the active palette without changing the selected theme
              family.
            </span>
          </div>
          <Button
            className={cn(
              "settings-toggle-btn",
              controller.themeMode === "dark" && "settings-toggle-btn--active",
            )}
            onClick={controller.toggleThemeMode}
            variant="secondary"
            size="xs"
          >
            <span className="material-symbols-outlined text-md">
              {controller.themeMode === "dark" ? "light_mode" : "dark_mode"}
            </span>
            <span>{controller.themeMode === "dark" ? "Light" : "Dark"}</span>
          </Button>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Group inline tool calls</span>
            <span className="settings-row-desc">
              Collapse consecutive auto-approved tool calls into a single
              expandable block by default.
            </span>
          </div>
          <ToggleSwitch
            checked={controller.groupInlineToolCalls}
            onChange={controller.setGroupInlineToolCalls}
            className="settings-switch"
            title="Group inline tool calls"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Communication Profile"
        description="Choose the agent's default conversational style and personality."
        actions={
          <Button
            type="button"
            size="xs"
            onClick={() => {
              controller.setIsAddingProfile(true);
              controller.setEditingProfileId(null);
            }}
            className="text-nowrap"
          >
            Add Custom Profile
          </Button>
        }
      >
        <div className="settings-provider-list mt-8">
          {controller.customProfiles.length === 0 &&
          !controller.isAddingProfile ? (
            <Panel variant="inset" className="settings-empty-panel">
              <span className="material-symbols-outlined settings-empty-panel__icon">
                forum
              </span>
              <div className="settings-empty-panel__copy">
                <span className="settings-empty-panel__title">
                  No custom profiles
                </span>
                <span className="settings-empty-panel__description">
                  Add a custom profile to tailor the agent to your needs.
                </span>
              </div>
            </Panel>
          ) : null}

          {controller.customProfiles.map((profile) => {
            return controller.editingProfileId === profile.id ? (
              <ProfileConfigurator
                key={profile.id}
                profile={profile}
                onSave={async (p) => {
                  await controller.saveProfile(p);
                  controller.setIsAddingProfile(false);
                  controller.setEditingProfileId(null);
                }}
                onCancel={() => controller.setEditingProfileId(null)}
              />
            ) : (
              <Panel
                key={profile.id}
                className={cn(
                  "settings-provider-card cursor-pointer transition-colors relative border",
                  controller.defaultCommunicationProfile === profile.id
                    ? "border-primary bg-primary/5"
                    : "border-transparent hover:border-primary/50",
                )}
                onClick={() =>
                  controller.setDefaultCommunicationProfile(profile.id)
                }
              >
                {controller.defaultCommunicationProfile === profile.id && (
                  <div className="absolute top-0 left-0 w-1 h-full bg-primary rounded-l-md" />
                )}
                <div className="flex flex-row items-center gap-3 min-w-0 flex-1 pl-2">
                  <span className="settings-provider-card__title shrink-0">
                    {profile.name}
                  </span>
                  <span
                    className="settings-provider-card__meta text-ellipsis overflow-hidden whitespace-nowrap"
                    title={profile.promptSnippet}
                  >
                    {profile.promptSnippet}
                  </span>
                </div>
                <div className="settings-provider-card__actions">
                  <IconButton
                    className="settings-provider-card__icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      controller.setEditingProfileId(profile.id);
                    }}
                    title={`Edit ${profile.name}`}
                    aria-label={`Edit ${profile.name}`}
                  >
                    <span className="material-symbols-outlined text-sm">
                      edit
                    </span>
                  </IconButton>
                  <IconButton
                    className="settings-provider-card__icon-btn settings-provider-card__icon-btn--danger"
                    disabled={controller.customProfiles.length <= 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      void controller.deleteProfile(profile.id);
                    }}
                    title={
                      controller.customProfiles.length <= 1
                        ? "You must keep at least one profile"
                        : `Delete ${profile.name}`
                    }
                    aria-label={
                      controller.customProfiles.length <= 1
                        ? "You must keep at least one profile"
                        : `Delete ${profile.name}`
                    }
                  >
                    <span className="material-symbols-outlined text-sm">
                      delete
                    </span>
                  </IconButton>
                </div>
              </Panel>
            );
          })}

          {controller.isAddingProfile ? (
            <ProfileConfigurator
              onSave={async (p) => {
                await controller.saveProfile(p);
                controller.setIsAddingProfile(false);
                controller.setEditingProfileId(null);
              }}
              onCancel={() => controller.setIsAddingProfile(false)}
            />
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

function ProfileConfigurator({
  profile,
  onSave,
  onCancel,
}: {
  profile?: CommunicationProfileRecord;
  onSave: (profile: CommunicationProfileRecord) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [promptSnippet, setPromptSnippet] = useState(
    profile?.promptSnippet ?? "",
  );

  const handleSaveClick = () => {
    if (!name.trim() || !promptSnippet.trim()) return;
    onSave({
      id: profile?.id ?? uuidv4(),
      name: name.trim(),
      promptSnippet: promptSnippet.trim(),
    });
  };

  return (
    <Panel className="settings-provider-form">
      <div className="settings-profile-form__grid">
        <div className="settings-field">
          <label className="settings-field-label">Profile Name</label>
          <TextField
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Code Reviewer"
            wrapClassName="settings-input-wrap"
          />
        </div>

        <div className="settings-field">
          <label className="settings-field-label">Prompt Snippet</label>
          <TextareaField
            value={promptSnippet}
            onChange={(e) => setPromptSnippet(e.target.value)}
            placeholder="You are an expert software engineer reviewing code..."
            wrapClassName="settings-input-wrap"
            rows={4}
          />
        </div>
      </div>

      <div className="settings-provider-form__footer">
        <div
          className="settings-provider-form__status"
          aria-live="polite"
        ></div>

        <div className="settings-provider-form__actions">
          <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={handleSaveClick}
            disabled={!name.trim() || !promptSnippet.trim()}
          >
            Save Profile
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function NotificationsSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  return (
    <SectionCard
      title="Attention Alerts"
      description="Control whether the app notifies you when an agent needs approval or worktree input."
    >
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Agent attention</span>
          <span className="settings-row-desc">
            Desktop notifications are shown when focus is elsewhere or the
            relevant tab is inactive.
          </span>
        </div>
        <ToggleSwitch
          checked={controller.notifyOnAttention}
          onChange={() => {
            void controller.toggleNotifyOnAttention();
          }}
          className="settings-switch"
        />
      </div>
    </SectionCard>
  );
}

function ContextCompactionSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  const autoSettings = controller.autoContextCompactionSettings;

  const updateAutoSettings = (
    patch: Partial<typeof controller.autoContextCompactionSettings>,
  ) => {
    controller.setAutoContextCompactionSettings({
      ...autoSettings,
      ...patch,
    });
  };

  return (
    <div className="settings-page__section-stack">
      <SectionCard
        title="Tool Context Compaction"
        description="Control whether the runner may rewrite model-facing tool IO for allowlisted local tools while keeping raw tool data visible in chat."
      >
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Enable tool IO compaction</span>
            <span className="settings-row-desc">
              Lets the model replace large allowlisted tool inputs and outputs
              with compact sentinels while preserving raw args and results in
              the UI.
            </span>
          </div>
          <ToggleSwitch
            checked={controller.toolContextCompactionEnabled}
            onChange={controller.setToolContextCompactionEnabled}
            className="settings-switch"
            title="Tool context compaction"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Compactor Sub-agent"
        description="Automatically run the internal Context Compaction sub-agent when the main agent context crosses a threshold, then resume the main loop with the compacted history."
      >
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Enable automatic compaction</span>
            <span className="settings-row-desc">
              Runs the internal compactor in the background and continues the
              active main-agent run after the summary is applied.
            </span>
          </div>
          <ToggleSwitch
            checked={autoSettings.enabled}
            onChange={(enabled) => updateAutoSettings({ enabled })}
            className="settings-switch"
            title="Automatic context compaction"
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Trigger mode</span>
            <span className="settings-row-desc">
              Choose whether automatic compaction is based on the current
              context window percentage or the estimated context size in KB.
            </span>
          </div>
          <SelectField
            className="settings-select settings-select--compact"
            value={autoSettings.thresholdMode}
            onChange={(event) =>
              updateAutoSettings({
                thresholdMode: event.target.value as "percentage" | "kb",
              })
            }
            disabled={!autoSettings.enabled}
            aria-label="Auto-compaction trigger mode"
          >
            <option value="percentage">Context window %</option>
            <option value="kb">Context size (KB)</option>
          </SelectField>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Threshold</span>
            <span className="settings-row-desc">
              {autoSettings.thresholdMode === "percentage"
                ? "Percentage mode relies on the selected model's context window metadata."
                : "KB mode uses the estimated size of the live model-facing apiMessages history."}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <TextField
              type="number"
              inputMode="numeric"
              min={1}
              max={autoSettings.thresholdMode === "percentage" ? 100 : 1048576}
              value={
                autoSettings.thresholdMode === "percentage"
                  ? autoSettings.thresholdPercent
                  : autoSettings.thresholdKb
              }
              onChange={(event) => {
                const nextValue = Number.parseInt(event.target.value, 10);
                if (!Number.isFinite(nextValue)) return;
                if (autoSettings.thresholdMode === "percentage") {
                  updateAutoSettings({ thresholdPercent: nextValue });
                } else {
                  updateAutoSettings({ thresholdKb: nextValue });
                }
              }}
              disabled={!autoSettings.enabled}
              aria-label="Auto-compaction threshold"
              wrapClassName="settings-input-wrap w-28"
            />
            <span className="settings-row-desc shrink-0">
              {autoSettings.thresholdMode === "percentage" ? "%" : "KB"}
            </span>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

function VoiceStatus({
  voiceDownloadStatus,
  voiceModelPath,
  voiceDownloadError,
}: {
  voiceDownloadStatus: VoiceDownloadStatus;
  voiceModelPath: string;
  voiceDownloadError: string | null;
}) {
  if (voiceDownloadStatus === "downloading") {
    return (
      <p className="settings-voice-status settings-voice-status--loading">
        <span className="material-symbols-outlined settings-voice-spinner">
          progress_activity
        </span>
        Downloading Whisper model...
      </p>
    );
  }

  if (voiceDownloadStatus === "ready" && voiceModelPath) {
    return (
      <div className="settings-voice-status settings-voice-status--ready">
        <span className="material-symbols-outlined text-md">check_circle</span>
        <div className="settings-voice-status-copy">
          <span>Model downloaded</span>
          <code className="settings-voice-path">{voiceModelPath}</code>
        </div>
      </div>
    );
  }

  if (voiceDownloadStatus === "error" && voiceDownloadError) {
    return (
      <p className="settings-voice-status settings-voice-status--error">
        <span className="material-symbols-outlined text-md">error</span>
        {voiceDownloadError}
      </p>
    );
  }

  return null;
}

function VoiceSection({ controller }: { controller: SettingsControllerValue }) {
  return (
    <SectionCard
      title="Voice Input"
      description="Use the microphone with a locally prepared Whisper model for chat transcription."
    >
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Enable voice input</span>
          <span className="settings-row-desc">
            The Whisper model is prepared on demand and stored locally.
          </span>
        </div>
        <ToggleSwitch
          checked={controller.voiceInputEnabled}
          className="settings-switch"
          onChange={() => {
            void controller.toggleVoiceInput(!controller.voiceInputEnabled);
          }}
          disabled={controller.voiceDownloadStatus === "downloading"}
        />
      </div>

      <VoiceStatus
        voiceDownloadStatus={controller.voiceDownloadStatus}
        voiceModelPath={controller.voiceModelPath}
        voiceDownloadError={controller.voiceDownloadError}
      />
    </SectionCard>
  );
}

function ProvidersSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  const [editingProviderId, setEditingProviderId] = useState<string | null>(
    null,
  );
  const [isAdding, setIsAdding] = useState(false);
  const [providerRefreshStatus, setProviderRefreshStatus] = useState<
    Record<string, ProviderRefreshStatus>
  >({});
  const [modelsDevStatus, setModelsDevStatus] = useState<ModelsDevStatus>(
    modelsDevIndexCache ? "ready" : "loading",
  );
  const [modelsDevError, setModelsDevError] = useState<string | null>(null);
  const [modelsDevOffersByModelId, setModelsDevOffersByModelId] = useState<
    Record<string, ModelsDevOffer[]>
  >(modelsDevIndexCache?.offersByModelId ?? {});
  const refreshResetTimeoutsRef = useRef<Record<string, number>>({});

  const clearRefreshResetTimeout = useCallback((providerId: string) => {
    const timeoutId = refreshResetTimeoutsRef.current[providerId];
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      delete refreshResetTimeoutsRef.current[providerId];
    }
  }, []);

  const scheduleRefreshStatusReset = useCallback(
    (providerId: string) => {
      clearRefreshResetTimeout(providerId);
      refreshResetTimeoutsRef.current[providerId] = window.setTimeout(() => {
        setProviderRefreshStatus((prev) => ({ ...prev, [providerId]: "idle" }));
        delete refreshResetTimeoutsRef.current[providerId];
      }, REFRESH_FEEDBACK_MS);
    },
    [clearRefreshResetTimeout],
  );

  useEffect(() => {
    if (modelsDevIndexCache) return;

    let cancelled = false;

    void loadModelsDevIndex()
      .then((index) => {
        if (cancelled) return;
        setModelsDevOffersByModelId(index.offersByModelId);
        setModelsDevStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setModelsDevStatus("error");
        setModelsDevError(
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      Object.values(refreshResetTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      refreshResetTimeoutsRef.current = {};
    };
  }, []);

  const envProviderCandidates = controller.envKeysAvailable
    .map((entry) => ({
      ...entry,
      label: entry.type === "openai" ? "OpenAI" : "Anthropic",
    }))
    .filter(
      (candidate) =>
        !controller.providers.some(
          (provider) => provider.type === candidate.type,
        ),
    );
  const showImportHint = envProviderCandidates.length > 0;

  const handleSaveProvider = async (provider: ProviderInstance) => {
    await saveProvider(provider);
    controller.setProviders([
      ...controller.providers.filter((p) => p.id !== provider.id),
      provider,
    ]);
    setIsAdding(false);
    setEditingProviderId(null);
  };

  const handleDeleteProvider = async (id: string) => {
    await deleteProvider(id);
    controller.setProviders(controller.providers.filter((p) => p.id !== id));
  };

  const handleRefreshProviderModels = async (provider: ProviderInstance) => {
    if (provider.type !== "openai-compatible") return;

    clearRefreshResetTimeout(provider.id);
    setProviderRefreshStatus((prev) => ({
      ...prev,
      [provider.id]: "loading",
    }));
    try {
      const models = await fetchOpenAICompatibleModels(
        provider.baseUrl ?? "",
        provider.apiKey,
      );
      const updatedProvider: ProviderInstance = {
        ...provider,
        cachedModels: mergeProviderCachedModels(provider.cachedModels, models),
      };

      await saveProvider(updatedProvider);
      controller.setProviders(
        controller.providers.map((currentProvider) =>
          currentProvider.id === updatedProvider.id
            ? updatedProvider
            : currentProvider,
        ),
      );
      setProviderRefreshStatus((prev) => ({ ...prev, [provider.id]: "ok" }));
      scheduleRefreshStatusReset(provider.id);
    } catch (error) {
      logFrontendSoon({
        level: "error",
        tags: ["frontend", "system"],
        event: "settings.providers.refresh-models.error",
        message: `Failed to refresh OpenAI-compatible models for "${provider.name}".`,
        data: { error, providerId: provider.id, providerName: provider.name },
      });
      setProviderRefreshStatus((prev) => ({
        ...prev,
        [provider.id]: "error",
      }));
      scheduleRefreshStatusReset(provider.id);
    }
  };

  const handleImportProviderFromEnv = async (
    type: EnvProviderType,
    apiKey: string,
  ) => {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) return;

    const alreadyExists = controller.providers.some(
      (provider) => provider.type === type,
    );
    if (alreadyExists) return;

    const defaultName = type === "openai" ? "OpenAI (Env)" : "Anthropic (Env)";
    const provider: ProviderInstance = {
      id: uuidv4(),
      name: buildUniqueProviderName(defaultName, controller.providers),
      type,
      apiKey: normalizedApiKey,
    };

    await saveProvider(provider);
    controller.setProviders([...controller.providers, provider]);
  };

  return (
    <div className="settings-page__section-stack">
      <SectionCard
        title="Provider Registry"
        description="Configure first-party and custom OpenAI-compatible providers. Keys remain local to this app."
        actions={
          <Button
            type="button"
            size="xs"
            onClick={() => {
              setIsAdding(true);
              setEditingProviderId(null);
            }}
            className="text-nowrap"
          >
            Add Provider
          </Button>
        }
      >
        {showImportHint ? (
          <Panel className="settings-callout">
            <div className="settings-callout__icon">
              <span className="material-symbols-outlined text-primary text-[18px]">
                tips_and_updates
              </span>
            </div>
            <div className="settings-callout__body">
              <p className="settings-callout__title">Import from environment</p>
              <p className="settings-callout__copy">
                API keys already available in the environment can be imported
                directly into the local provider registry.
              </p>
              <div className="settings-callout__actions">
                {envProviderCandidates.map((candidate) => (
                  <Button
                    key={`${candidate.type}-env-import`}
                    type="button"
                    variant="ghost"
                    size="xxs"
                    onClick={() =>
                      void handleImportProviderFromEnv(
                        candidate.type,
                        candidate.apiKey,
                      )
                    }
                  >
                    Import {candidate.label}
                  </Button>
                ))}
              </div>
            </div>
          </Panel>
        ) : null}

        <div className="settings-provider-list">
          {controller.providers.length === 0 && !isAdding ? (
            <Panel variant="inset" className="settings-empty-panel">
              <span className="material-symbols-outlined settings-empty-panel__icon">
                hub
              </span>
              <div className="settings-empty-panel__copy">
                <span className="settings-empty-panel__title">
                  No providers configured
                </span>
                <span className="settings-empty-panel__description">
                  Add a provider to populate the model picker and start new
                  agent runs.
                </span>
              </div>
            </Panel>
          ) : null}

          {controller.providers.map((provider) => {
            const refreshStatus = providerRefreshStatus[provider.id] ?? "idle";
            const refreshIcon =
              refreshStatus === "loading"
                ? "autorenew"
                : refreshStatus === "ok"
                  ? "check_circle"
                  : refreshStatus === "error"
                    ? "error"
                    : "refresh";
            const refreshTitle =
              refreshStatus === "loading"
                ? "Refreshing models…"
                : refreshStatus === "ok"
                  ? "Models refreshed."
                  : refreshStatus === "error"
                    ? "Refresh failed."
                    : "Refresh models";

            return editingProviderId === provider.id ? (
              <ProviderConfigurator
                key={provider.id}
                provider={provider}
                modelsDevStatus={modelsDevStatus}
                modelsDevError={modelsDevError}
                modelsDevOffersByModelId={modelsDevOffersByModelId}
                onSave={handleSaveProvider}
                onCancel={() => setEditingProviderId(null)}
              />
            ) : (
              <Panel key={provider.id} className="settings-provider-card">
                <div className="settings-provider-card__copy">
                  <span className="settings-provider-card__title">
                    {provider.name}
                  </span>
                  <span className="settings-provider-card__meta">
                    {provider.type}
                    {provider.type === "openai-compatible" &&
                    (provider.cachedModels?.length ?? 0) > 0
                      ? ` · ${provider.cachedModels?.length} model${
                          provider.cachedModels?.length === 1 ? "" : "s"
                        }`
                      : ""}
                  </span>
                </div>
                <div className="settings-provider-card__actions">
                  {provider.type === "openai-compatible" ? (
                    <IconButton
                      className={cn(
                        "settings-provider-card__icon-btn",
                        refreshStatus === "ok" &&
                          "settings-provider-card__icon-btn--success",
                        refreshStatus === "error" &&
                          "settings-provider-card__icon-btn--danger",
                      )}
                      onClick={() => void handleRefreshProviderModels(provider)}
                      title={refreshTitle}
                      aria-label={`Refresh models for ${provider.name}`}
                      disabled={refreshStatus === "loading"}
                    >
                      <span
                        className={cn(
                          "material-symbols-outlined text-sm",
                          refreshStatus === "loading" && "animate-spin",
                        )}
                      >
                        {refreshIcon}
                      </span>
                    </IconButton>
                  ) : null}
                  <IconButton
                    className="settings-provider-card__icon-btn"
                    onClick={() => setEditingProviderId(provider.id)}
                    title={`Edit ${provider.name}`}
                    aria-label={`Edit ${provider.name}`}
                  >
                    <span className="material-symbols-outlined text-sm">
                      edit
                    </span>
                  </IconButton>
                  <IconButton
                    className="settings-provider-card__icon-btn settings-provider-card__icon-btn--danger"
                    onClick={() => {
                      void handleDeleteProvider(provider.id);
                    }}
                    title={`Delete ${provider.name}`}
                    aria-label={`Delete ${provider.name}`}
                  >
                    <span className="material-symbols-outlined text-sm">
                      delete
                    </span>
                  </IconButton>
                </div>
              </Panel>
            );
          })}

          {isAdding ? (
            <ProviderConfigurator
              modelsDevStatus={modelsDevStatus}
              modelsDevError={modelsDevError}
              modelsDevOffersByModelId={modelsDevOffersByModelId}
              onSave={handleSaveProvider}
              onCancel={() => setIsAdding(false)}
            />
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

function McpServersSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [probeStatusById, setProbeStatusById] = useState<
    Record<string, ProviderRefreshStatus>
  >({});
  const probeResetTimeoutsRef = useRef<Record<string, number>>({});

  const clearProbeResetTimeout = useCallback((serverId: string) => {
    const timeoutId = probeResetTimeoutsRef.current[serverId];
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      delete probeResetTimeoutsRef.current[serverId];
    }
  }, []);

  const scheduleProbeStatusReset = useCallback(
    (serverId: string) => {
      clearProbeResetTimeout(serverId);
      probeResetTimeoutsRef.current[serverId] = window.setTimeout(() => {
        setProbeStatusById((prev) => ({ ...prev, [serverId]: "idle" }));
        delete probeResetTimeoutsRef.current[serverId];
      }, REFRESH_FEEDBACK_MS);
    },
    [clearProbeResetTimeout],
  );

  useEffect(() => {
    return () => {
      Object.values(probeResetTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      probeResetTimeoutsRef.current = {};
    };
  }, []);

  const handleSaveServer = async (server: McpServerConfig) => {
    const nextServers = [
      ...controller.mcpServers.filter((entry) => entry.id !== server.id),
      server,
    ];
    await saveMcpServers(nextServers);
    controller.setMcpServers(nextServers);
    setIsAdding(false);
    setEditingServerId(null);
  };

  const handleDeleteServer = async (serverId: string) => {
    const nextServers = controller.mcpServers.filter(
      (server) => server.id !== serverId,
    );
    await saveMcpServers(nextServers);
    controller.setMcpServers(nextServers);
  };

  const handleToggleEnabled = async (
    server: McpServerConfig,
    enabled: boolean,
  ) => {
    const nextServers = controller.mcpServers.map((entry) =>
      entry.id === server.id ? { ...entry, enabled } : entry,
    );
    await saveMcpServers(nextServers);
    controller.setMcpServers(nextServers);
  };

  const handleProbeServer = async (server: McpServerConfig) => {
    clearProbeResetTimeout(server.id);
    setProbeStatusById((prev) => ({ ...prev, [server.id]: "loading" }));
    try {
      await testMcpServer(server);
      setProbeStatusById((prev) => ({ ...prev, [server.id]: "ok" }));
      scheduleProbeStatusReset(server.id);
    } catch (error) {
      logFrontendSoon({
        level: "error",
        tags: ["frontend", "system"],
        event: "settings.mcp.probe.error",
        message: `Failed to probe MCP server "${server.name}".`,
        data: { error, serverId: server.id, serverName: server.name },
      });
      setProbeStatusById((prev) => ({ ...prev, [server.id]: "error" }));
      scheduleProbeStatusReset(server.id);
    }
  };

  const handleToggleArtifactizeReturnedFiles = async (enabled: boolean) => {
    const nextSettings = {
      ...controller.mcpSettings,
      artifactizeReturnedFiles: enabled,
    };
    await saveMcpSettings(nextSettings);
    controller.setMcpSettings(nextSettings);
  };

  return (
    <div className="settings-page__section-stack">
      <SectionCard
        title="Global MCP Registry"
        description="Configure the MCP servers that the main agent can discover for every run."
        actions={
          <Button
            type="button"
            size="xs"
            onClick={() => {
              setIsAdding(true);
              setEditingServerId(null);
            }}
            className="text-nowrap"
          >
            Add Server
          </Button>
        }
      >
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">
              Save returned files as artifacts
            </span>
            <span className="settings-row-desc">
              When enabled, MCP image or file payloads are stored as artifacts
              and replaced in model context with artifact references.
            </span>
          </div>
          <ToggleSwitch
            checked={controller.mcpSettings.artifactizeReturnedFiles}
            className="settings-switch"
            title="Save returned files as artifacts"
            onChange={() => {
              void handleToggleArtifactizeReturnedFiles(
                !controller.mcpSettings.artifactizeReturnedFiles,
              );
            }}
          />
        </div>

        <div className="settings-provider-list">
          {controller.mcpServers.length === 0 && !isAdding ? (
            <Panel variant="inset" className="settings-empty-panel">
              <span className="material-symbols-outlined settings-empty-panel__icon">
                extension
              </span>
              <div className="settings-empty-panel__copy">
                <span className="settings-empty-panel__title">
                  No MCP servers configured
                </span>
                <span className="settings-empty-panel__description">
                  Add a global MCP server to discover external tools at run
                  start.
                </span>
              </div>
            </Panel>
          ) : null}

          {controller.mcpServers.map((server) => {
            const probeStatus = probeStatusById[server.id] ?? "idle";
            const probeIcon =
              probeStatus === "loading"
                ? "autorenew"
                : probeStatus === "ok"
                  ? "check_circle"
                  : probeStatus === "error"
                    ? "error"
                    : "bolt";
            const probeTitle =
              probeStatus === "loading"
                ? "Testing server…"
                : probeStatus === "ok"
                  ? "Server probe passed."
                  : probeStatus === "error"
                    ? "Server probe failed."
                    : "Test server";

            return editingServerId === server.id ? (
              <McpServerConfigurator
                key={server.id}
                server={server}
                themeMode={controller.themeMode}
                onSave={handleSaveServer}
                onCancel={() => setEditingServerId(null)}
              />
            ) : (
              <Panel key={server.id} className="settings-provider-card">
                <div className="settings-provider-card__copy">
                  <span className="settings-provider-card__title">
                    {server.name}
                  </span>
                  <span className="settings-provider-card__meta">
                    {server.transport}
                    {" · "}
                    {server.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <div className="settings-provider-card__actions">
                  <ToggleSwitch
                    checked={server.enabled}
                    className="settings-switch"
                    onChange={() =>
                      void handleToggleEnabled(server, !server.enabled)
                    }
                  />
                  <IconButton
                    className={cn(
                      "settings-provider-card__icon-btn",
                      probeStatus === "ok" &&
                        "settings-provider-card__icon-btn--success",
                      probeStatus === "error" &&
                        "settings-provider-card__icon-btn--danger",
                    )}
                    onClick={() => void handleProbeServer(server)}
                    title={probeTitle}
                    aria-label={`Test ${server.name}`}
                    disabled={probeStatus === "loading"}
                  >
                    <span
                      className={cn(
                        "material-symbols-outlined text-sm",
                        probeStatus === "loading" && "animate-spin",
                      )}
                    >
                      {probeIcon}
                    </span>
                  </IconButton>
                  <IconButton
                    className="settings-provider-card__icon-btn"
                    onClick={() => setEditingServerId(server.id)}
                    title={`Edit ${server.name}`}
                    aria-label={`Edit ${server.name}`}
                  >
                    <span className="material-symbols-outlined text-sm">
                      edit
                    </span>
                  </IconButton>
                  <IconButton
                    className="settings-provider-card__icon-btn settings-provider-card__icon-btn--danger"
                    onClick={() => {
                      void handleDeleteServer(server.id);
                    }}
                    title={`Delete ${server.name}`}
                    aria-label={`Delete ${server.name}`}
                  >
                    <span className="material-symbols-outlined text-sm">
                      delete
                    </span>
                  </IconButton>
                </div>
              </Panel>
            );
          })}

          {isAdding ? (
            <McpServerConfigurator
              themeMode={controller.themeMode}
              onSave={handleSaveServer}
              onCancel={() => setIsAdding(false)}
            />
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

function UpdatesSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  const updaterStatusLabel = getAppUpdaterStatusLabel(controller.appUpdater);
  const updaterStatusVariant = getAppUpdaterStatusVariant(
    controller.appUpdater,
  );
  const updaterProgressValue = getAppUpdaterProgressValue(
    controller.appUpdater,
  );
  const isCheckingUpdates = controller.appUpdater.status === "checking";
  const isInstallingUpdate =
    controller.appUpdater.status === "downloading" ||
    controller.appUpdater.status === "installing" ||
    controller.appUpdater.status === "restarting";
  const installButtonLabel = isInstallingUpdate
    ? controller.appUpdater.status === "downloading"
      ? "Downloading…"
      : controller.appUpdater.status === "installing"
        ? "Installing…"
        : "Restarting…"
    : controller.appUpdater.availableVersion
      ? `Install v${controller.appUpdater.availableVersion}`
      : "Install update";
  const availableDateLabel = controller.appUpdater.availableDate
    ? new Date(controller.appUpdater.availableDate).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const cliInstallButtonLabel = controller.cliStatusLoading
    ? controller.cliStatus?.installed
      ? "Reinstalling…"
      : "Installing…"
    : controller.cliStatus?.installed
      ? "Reinstall"
      : "Install";
  const cliInstalledVariant = controller.cliStatus?.installed
    ? "success"
    : "muted";

  return (
    <div className="flex flex-col gap-4">
      <SectionCard
        title="Release Channel"
        description="Check for signed releases from GitHub and install them without leaving the app."
      >
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Current version</span>
            <span className="settings-row-desc">v{pkg.version}</span>
          </div>
          <Badge variant={updaterStatusVariant}>{updaterStatusLabel}</Badge>
        </div>

        {controller.appUpdater.availableVersion ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Available version</span>
              <span className="settings-row-desc">
                v{controller.appUpdater.availableVersion}
                {availableDateLabel ? ` • ${availableDateLabel}` : ""}
              </span>
            </div>
          </div>
        ) : null}

        <Panel variant="inset" className="settings-updates-panel">
          <p className="settings-section-desc">
            {formatUpdaterLastChecked(controller.appUpdater.lastCheckedAt)}
          </p>

          {updaterProgressValue !== null ? (
            <p className="settings-feedback settings-feedback--primary">
              Download progress: {updaterProgressValue}%
            </p>
          ) : null}

          {controller.appUpdater.error ? (
            <p className="settings-feedback settings-feedback--error">
              {controller.appUpdater.error}
            </p>
          ) : null}

          {controller.appUpdater.releaseNotes ? (
            <div className="settings-release-notes">
              <p className="settings-release-notes__label">Release notes</p>
              <p className="settings-release-notes__body">
                {controller.appUpdater.releaseNotes}
              </p>
            </div>
          ) : null}

          <div className="settings-updates-panel__actions">
            <Button
              type="button"
              onClick={() => {
                void controller.checkForUpdates();
              }}
              disabled={isCheckingUpdates || isInstallingUpdate}
              variant={
                controller.appUpdater.availableVersion ? "secondary" : "primary"
              }
              size="xs"
              loading={isCheckingUpdates}
            >
              {isCheckingUpdates ? "Checking…" : "Check for updates"}
            </Button>

            {controller.appUpdater.availableVersion ? (
              <Button
                type="button"
                onClick={() => {
                  void controller.installUpdate();
                }}
                disabled={isCheckingUpdates || isInstallingUpdate}
                size="xs"
                loading={isInstallingUpdate}
              >
                {installButtonLabel}
              </Button>
            ) : null}
          </div>
        </Panel>
      </SectionCard>

      <SectionCard
        title="Command-line launcher"
        description="Install the CLI too. This makes the `rakh` binary available in your terminal so you can open the app from the command line."
      >
        {controller.cliStatus ? (
          <>
            <div className="flex justify-end">
              <Badge variant={cliInstalledVariant}>
                {controller.cliStatus.installed ? "Installed" : "Not installed"}
              </Badge>
            </div>

            {controller.cliStatus.manualPathSnippet ? (
              <div className="flex flex-col gap-2">
                <CopyableCodePill
                  value={controller.cliStatus.manualPathSnippet}
                  label="CLI PATH snippet"
                  multiline
                />
              </div>
            ) : null}
          </>
        ) : (
          <p className="settings-section-desc">
            Command-line launcher management is available in the desktop app.
          </p>
        )}

        {controller.cliStatusError ? (
          <p className="settings-feedback settings-feedback--error">
            {controller.cliStatusError}
          </p>
        ) : null}

        <div className="settings-updates-panel__actions">
          <Button
            type="button"
            size="xs"
            onClick={() => {
              void controller.installCliLauncher();
            }}
            loading={controller.cliStatusLoading}
          >
            {cliInstallButtonLabel}
          </Button>
          {controller.cliStatus?.installed ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                void controller.uninstallCliLauncher();
              }}
              disabled={controller.cliStatusLoading}
            >
              Uninstall
            </Button>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

/* ── CommandListSection ───────────────────────────────────────────────────── */

const MATCH_MODE_OPTIONS: { value: MatchMode; label: string }[] = [
  { value: "prefix", label: "Starts with" },
  { value: "exact", label: "Exact" },
  { value: "glob", label: "Glob (*)" },
];

function CommandEntryForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CommandListEntry;
  onSave: (entry: Omit<CommandListEntry, "id" | "source">) => void;
  onCancel: () => void;
}) {
  const [pattern, setPattern] = useState(initial?.pattern ?? "");
  const [matchMode, setMatchMode] = useState<MatchMode>(
    initial?.matchMode ?? "prefix",
  );
  const [description, setDescription] = useState(initial?.description ?? "");

  const handleSubmit = () => {
    const trimmed = pattern.trim();
    if (!trimmed) return;
    onSave({
      pattern: trimmed,
      matchMode,
      description: description.trim() || undefined,
    });
  };

  return (
    <Panel className="settings-provider-form">
      <div className="settings-provider-form__grid">
        <div className="settings-field">
          <label className="settings-field-label">Pattern</label>
          <TextField
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="e.g. npm test or rm -rf *"
            autoFocus
            wrapClassName="settings-input-wrap"
          />
        </div>
        <div className="settings-field">
          <label className="settings-field-label">Match mode</label>
          <SelectField
            className="settings-input settings-provider-form__select"
            value={matchMode}
            onChange={(e) => setMatchMode(e.target.value as MatchMode)}
          >
            {MATCH_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="settings-field settings-field--full-span">
          <label className="settings-field-label">
            Description <span style={{ fontWeight: 400 }}>(optional)</span>
          </label>
          <TextField
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short note for your own reference"
            wrapClassName="settings-input-wrap"
          />
        </div>
      </div>
      <div className="settings-provider-form__footer">
        <div className="settings-provider-form__status" />
        <div className="settings-provider-form__actions">
          <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={handleSubmit}
            disabled={!pattern.trim()}
          >
            Save
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function CommandEntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: CommandListEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isDefault = entry.source === "default";
  const isSubagent = entry.source !== "user" && entry.source !== "default";
  const modeLabelMap: Record<MatchMode, string> = {
    exact: "Exact",
    prefix: "Starts with",
    glob: "Glob",
  };

  return (
    <Panel className="settings-provider-card">
      <div className="settings-provider-card__copy">
        <span className="settings-provider-card__title">
          <code>{entry.pattern}</code>
        </span>
        <span className="settings-provider-card__meta">
          {modeLabelMap[entry.matchMode]}
          {entry.description ? ` · ${entry.description}` : ""}
        </span>
      </div>
      <div className="settings-provider-card__actions">
        {isDefault && <Badge variant="muted">built-in</Badge>}
        {isSubagent && <Badge variant="primary">{entry.source}</Badge>}
        <IconButton
          className="settings-provider-card__icon-btn"
          onClick={onEdit}
          title="Edit entry"
          aria-label="Edit entry"
        >
          <span className="material-symbols-outlined text-sm">edit</span>
        </IconButton>
        <IconButton
          className="settings-provider-card__icon-btn settings-provider-card__icon-btn--danger"
          onClick={onDelete}
          title={isDefault ? "Remove built-in safety rule" : "Delete entry"}
          aria-label="Delete entry"
        >
          <span className="material-symbols-outlined text-sm">delete</span>
        </IconButton>
      </div>
    </Panel>
  );
}

function CommandListSubpanel({
  title,
  description,
  entries,
  emptyIcon,
  emptyTitle,
  emptyDesc,
  listName,
  onAdd,
  onEdit,
  onDelete,
}: {
  title: string;
  description: string;
  entries: CommandListEntry[];
  emptyIcon: string;
  emptyTitle: string;
  emptyDesc: string;
  listName: "allow" | "deny";
  onAdd: (
    listName: "allow" | "deny",
    entry: Omit<CommandListEntry, "id" | "source">,
  ) => void;
  onEdit: (listName: "allow" | "deny", entry: CommandListEntry) => void;
  onDelete: (listName: "allow" | "deny", id: string) => void;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        <Button
          type="button"
          size="xs"
          onClick={() => {
            setIsAdding(true);
            setEditingId(null);
          }}
          className="text-nowrap"
        >
          Add Entry
        </Button>
      }
    >
      <div className="settings-provider-list">
        {isAdding ? (
          <CommandEntryForm
            onSave={(entry) => {
              onAdd(listName, entry);
              setIsAdding(false);
            }}
            onCancel={() => setIsAdding(false)}
          />
        ) : null}

        {entries.length === 0 && !isAdding ? (
          <Panel variant="inset" className="settings-empty-panel">
            <span className="material-symbols-outlined settings-empty-panel__icon">
              {emptyIcon}
            </span>
            <div className="settings-empty-panel__copy">
              <span className="settings-empty-panel__title">{emptyTitle}</span>
              <span className="settings-empty-panel__description">
                {emptyDesc}
              </span>
            </div>
          </Panel>
        ) : null}

        {entries.map((entry) =>
          editingId === entry.id ? (
            <CommandEntryForm
              key={entry.id}
              initial={entry}
              onSave={(updated) => {
                onEdit(listName, { ...entry, ...updated });
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <CommandEntryRow
              key={entry.id}
              entry={entry}
              onEdit={() => setEditingId(entry.id)}
              onDelete={() => onDelete(listName, entry.id)}
            />
          ),
        )}
      </div>
    </SectionCard>
  );
}

function DeveloperSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  return (
    <SectionCard
      title="Diagnostics"
      description="Control debug-only UI and the detached log viewer shortcut."
    >
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Debug mode</span>
          <span className="settings-row-desc">
            Enables stream-event logging, extra debug UI, and the log viewer
            button beside Settings in the title bar.
          </span>
        </div>
        <ToggleSwitch
          checked={controller.debugModeEnabled}
          onChange={controller.setDebugModeEnabled}
          className="settings-switch"
          title="Debug mode"
        />
      </div>
    </SectionCard>
  );
}

function CommandListSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  const handleAdd = async (
    listName: "allow" | "deny",
    entry: Omit<CommandListEntry, "id" | "source">,
  ) => {
    const { v4 } = await import("uuid");
    const full: CommandListEntry = { ...entry, id: v4(), source: "user" };
    await controller.addCommandEntry(listName, full);
  };

  const handleEdit = async (
    listName: "allow" | "deny",
    entry: CommandListEntry,
  ) => {
    await controller.updateCommandEntry(listName, entry);
  };

  const handleDelete = async (listName: "allow" | "deny", id: string) => {
    await controller.removeCommandEntry(listName, id);
  };

  return (
    <div className="settings-page__section-stack">
      <CommandListSubpanel
        title="Allow List"
        description="Commands on this list are auto-approved when auto-run is set to Agent or Yes. Has no effect when auto-run is Off."
        entries={controller.commandList.allow}
        emptyIcon="check_circle"
        emptyTitle="No allowed commands"
        emptyDesc="Add commands to skip approval prompts when auto-run is active."
        listName="allow"
        onAdd={(l, e) => {
          void handleAdd(l, e);
        }}
        onEdit={(l, e) => {
          void handleEdit(l, e);
        }}
        onDelete={(l, id) => {
          void handleDelete(l, id);
        }}
      />
      <CommandListSubpanel
        title="Deny List"
        description="Commands on this list always prompt for approval with a danger warning, even in auto-run mode."
        entries={controller.commandList.deny}
        emptyIcon="block"
        emptyTitle="No denied commands"
        emptyDesc="Add commands that should always require user confirmation."
        listName="deny"
        onAdd={(l, e) => {
          void handleAdd(l, e);
        }}
        onEdit={(l, e) => {
          void handleEdit(l, e);
        }}
        onDelete={(l, id) => {
          void handleDelete(l, id);
        }}
      />
    </div>
  );
}

function renderSection(
  sectionId: SettingsSectionId,
  controller: SettingsControllerValue,
) {
  switch (sectionId) {
    case "appearance":
      return <AppearanceSection controller={controller} />;
    case "notifications":
      return <NotificationsSection controller={controller} />;
    case "providers":
      return <ProvidersSection controller={controller} />;
    case "context-compaction":
      return <ContextCompactionSection controller={controller} />;
    case "mcp":
      return <McpServersSection controller={controller} />;
    case "voice":
      return <VoiceSection controller={controller} />;
    case "command-list":
      return <CommandListSection controller={controller} />;
    case "developer":
      return <DeveloperSection controller={controller} />;
    case "updates":
      return <UpdatesSection controller={controller} />;
    default:
      return <AppearanceSection controller={controller} />;
  }
}

export interface SettingsSurfaceProps {
  controller: SettingsControllerValue;
  activeSectionId?: SettingsSectionId;
  onChangeSection: (sectionId: SettingsSectionId) => void;
}

export default function SettingsSurface({
  controller,
  activeSectionId = DEFAULT_SETTINGS_SECTION,
  onChangeSection,
}: SettingsSurfaceProps) {
  const activeSection = getSettingsSectionDefinition(activeSectionId);
  const activeBadge = getSettingsSectionBadge(
    activeSection.id,
    controller.appUpdater,
  );

  return (
    <div className="settings-shell">
      <div className="settings-shell__body">
        <aside className="settings-nav" aria-label="Settings sections">
          {SETTINGS_SECTION_GROUPS.map((group) => (
            <div key={group.id} className="settings-nav__group">
              <div className="settings-nav__group-label">{group.label}</div>
              <div className="settings-nav__items">
                {getSettingsSectionsForGroup(group.id).map((section) => {
                  const badge = getSettingsSectionBadge(
                    section.id,
                    controller.appUpdater,
                  );
                  const isActive = section.id === activeSection.id;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={cn(
                        "settings-nav__item",
                        isActive && "settings-nav__item--active",
                      )}
                      onClick={() => onChangeSection(section.id)}
                    >
                      <div className="settings-nav__item-main">
                        <span className="material-symbols-outlined settings-nav__item-icon">
                          {section.icon}
                        </span>
                        <div className="settings-nav__item-copy">
                          <span className="settings-nav__item-label">
                            {section.label}
                          </span>
                        </div>
                      </div>
                      {badge ? (
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </aside>

        <section
          className="settings-page"
          aria-labelledby="settings-page-title"
        >
          <div className="settings-page__header">
            <div className="settings-page__header-copy">
              <div className="settings-page__title-row">
                <span className="material-symbols-outlined settings-page__title-icon text-xl">
                  {activeSection.icon}
                </span>
                <h2 id="settings-page-title" className="settings-page__title">
                  {activeSection.label}
                </h2>
              </div>
              <p className="settings-page__description">
                {activeSection.description}
              </p>
            </div>
            <div className="settings-page__header-meta">
              {activeBadge ? (
                <Badge variant={activeBadge.variant}>{activeBadge.label}</Badge>
              ) : null}
            </div>
          </div>

          <div className="settings-page__content">
            {renderSection(activeSection.id, controller)}
          </div>
        </section>
      </div>
    </div>
  );
}
