import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { cn } from "@/utils/cn";
import { type ProviderInstance, saveProvider } from "@/agent/db";
import {
  useEnvProviderKeys,
  buildUniqueProviderName,
  type EnvProviderType,
} from "@/agent/useEnvProviderKeys";

interface ProviderSetupHintProps {
  providers: ProviderInstance[];
  onProvidersChange: (providers: ProviderInstance[]) => void;
  onOpenSettings: () => void;
  className?: string;
}

export default function ProviderSetupHint({
  providers,
  onProvidersChange,
  onOpenSettings,
  className,
}: ProviderSetupHintProps) {
  const envKeysAvailable = useEnvProviderKeys();
  const [importError, setImportError] = useState<string | null>(null);

  const hasEnvKeys = envKeysAvailable.length > 0;

  const handleImportProvidersFromEnv = async () => {
    setImportError(null);
    try {
      const nextProviders = [...providers];

      for (const candidate of envKeysAvailable) {
        const alreadyExists = nextProviders.some(
          (provider) => provider.type === candidate.type,
        );
        if (alreadyExists) continue;

        const defaultName =
          candidate.type === "openai" ? "OpenAI (Env)" : "Anthropic (Env)";
        const provider: ProviderInstance = {
          id: uuidv4(),
          name: buildUniqueProviderName(defaultName, nextProviders),
          type: candidate.type as EnvProviderType,
          apiKey: candidate.apiKey,
        };

        await saveProvider(provider);
        nextProviders.push(provider);
      }

      onProvidersChange(nextProviders);
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Failed to import env key.",
      );
    } finally {
      onOpenSettings();
    }
  };

  if (!hasEnvKeys) {
    return (
      <div
        className={cn(
          "rounded-xl border border-warning/30 bg-warning/5 px-4 py-4 text-left shadow-sm",
          className,
        )}
      >
        <div className="flex gap-3">
          {/* icon badge */}
          <div className="grid size-8 shrink-0 place-items-center rounded-lg text-warning">
            <span className="material-symbols-outlined text-[18px] leading-none">
              warning
            </span>
          </div>

          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">
              Provider setup required
            </p>

            <p className="mt-1 text-xs leading-relaxed text-muted">
              No AI providers are configured yet. Add an OpenAI, Anthropic, or
              OpenAI-compatible provider to get started.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary/70 px-3 py-1.5 text-xs font-medium text-warning-foreground shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-warning/40"
              >
                <span className="material-symbols-outlined text-[16px]">
                  settings
                </span>
                Open settings
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-primary/30 bg-primary/5 px-4 py-4 text-left shadow-sm",
        className,
      )}
    >
      <div className="flex gap-3">
        {/* icon badge */}
        <div className="grid size-8 shrink-0 place-items-center rounded-lg text-primary">
          <span className="material-symbols-outlined text-xl leading-none">
            auto_awesome
          </span>
        </div>

        <div className="flex-1">
          <p className="text-sm font-semibold text-primary">
            Good news — you're already set up
          </p>

          <p className="mt-1 text-xs leading-relaxed text-muted">
            You already have environment variables for{" "}
            <span className="font-medium text-foreground/90">
              {envKeysAvailable
                .map((candidate) =>
                  candidate.type === "openai" ? "OpenAI" : "Anthropic",
                )
                .join(" and ")}
            </span>
            .
          </p>

          {/* actions */}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void handleImportProvidersFromEnv();
              }}
              className="cursor-pointer inline-flex items-center gap-1.5 rounded-md bg-primary/70 px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <span className="material-symbols-outlined text-lg">input</span>
              Import
            </button>

            <button
              type="button"
              onClick={onOpenSettings}
              className="cursor-pointer inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-primary/40 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <span className="material-symbols-outlined text-lg">
                settings
              </span>
              Add manually
            </button>
          </div>

          {importError && (
            <p className="mt-2 text-xs text-error">{importError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
