import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  useFilteredModels,
  fmtCtx,
  fmtPrice,
  type GatewayModel,
} from "@/agent/useModels";
import { cn } from "@/utils/cn";
import { AdvancedModelOptionsButton } from "@/components/AdvancedModelOptions";
import { Button, TextField } from "@/components/ui";
import type { AdvancedModelOptions } from "@/agent/types";

interface NewSessionModelSelectorProps {
  models: GatewayModel[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  onModelSelected?: () => void;
  loading: boolean;
  error: string | null;
  hasAnyProviderKey: boolean;
  advancedOptions?: AdvancedModelOptions;
  onAdvancedOptionsChange?: (opts: AdvancedModelOptions) => void;
  communicationProfile?: string;
  onCommunicationProfileChange?: (profile: string) => void;
}

type ProviderBadgeProps = {
  provider?: string | null;
  className?: string;
};

function getProviderMeta(provider?: string | null): {
  label: string;
  icon: string;
} {
  if (provider === "openai") {
    return { label: "OpenAI", icon: "bolt" };
  }
  if (provider === "anthropic") {
    return { label: "Anthropic", icon: "menu_book" };
  }
  return { label: "Custom", icon: "hub" };
}

function ProviderBadge({ provider, className = "" }: ProviderBadgeProps) {
  const { label, icon } = getProviderMeta(provider);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xxs px-2 py-px rounded-sm tracking-[0.04em] font-semibold border border-border-subtle bg-inset text-muted",
        className,
      )}
    >
      <span className="material-symbols-outlined text-xs leading-none">
        {icon}
      </span>
      <span>{label}</span>
    </span>
  );
}

export default function NewSessionModelSelector({
  models,
  selectedModel,
  onSelectModel,
  onModelSelected,
  loading,
  error,
  hasAnyProviderKey,
  advancedOptions,
  onAdvancedOptionsChange,
  communicationProfile,
  onCommunicationProfileChange,
}: NewSessionModelSelectorProps) {
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [activeModelIndex, setActiveModelIndex] = useState(-1);

  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelOptionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedModelObj = models.find((m) => m.id === selectedModel);
  const hasProviderModels = models.length > 0;
  const filteredModels = useFilteredModels(models, modelSearch);
  const selectedProvider = selectedModelObj?.owned_by ?? null;
  const resolvedActiveModelIndex = useMemo(() => {
    if (!modelDropdownOpen || filteredModels.length === 0) return -1;
    if (activeModelIndex >= 0 && activeModelIndex < filteredModels.length) {
      return activeModelIndex;
    }
    const selectedIndex = filteredModels.findIndex((m) => m.id === selectedModel);
    return selectedIndex >= 0 ? selectedIndex : 0;
  }, [activeModelIndex, filteredModels, modelDropdownOpen, selectedModel]);

  const closeModelDropdown = () => {
    setModelDropdownOpen(false);
    setActiveModelIndex(-1);
  };

  const openModelDropdown = () => {
    setModelSearch("");
    setModelDropdownOpen(true);
  };

  useEffect(() => {
    if (!modelDropdownOpen) return;

    const onDown = (e: MouseEvent) => {
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(e.target as Node)
      ) {
        closeModelDropdown();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelDropdownOpen]);



  useEffect(() => {
    if (!modelDropdownOpen) return;
    requestAnimationFrame(() => modelSearchRef.current?.focus());
  }, [modelDropdownOpen]);

  useEffect(() => {
    if (!modelDropdownOpen || resolvedActiveModelIndex < 0) return;
    modelOptionRefs.current[resolvedActiveModelIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [modelDropdownOpen, resolvedActiveModelIndex]);

  const selectModel = (m: GatewayModel) => {
    onSelectModel(m.id);
    closeModelDropdown();
    onModelSelected?.();
  };

  const moveActiveModel = (direction: "up" | "down") => {
    if (filteredModels.length === 0) {
      setActiveModelIndex(-1);
      return;
    }

    setActiveModelIndex((prev) => {
      const startIndex =
        prev >= 0 && prev < filteredModels.length ? prev : resolvedActiveModelIndex;

      if (startIndex < 0 || startIndex >= filteredModels.length) {
        return direction === "down" ? 0 : filteredModels.length - 1;
      }

      if (direction === "down") {
        return (startIndex + 1) % filteredModels.length;
      }

      return (startIndex - 1 + filteredModels.length) % filteredModels.length;
    });
  };

  const handleModelSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActiveModel("down");
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActiveModel("up");
      return;
    }

    if (e.key === "Enter") {
      if (
        resolvedActiveModelIndex < 0 ||
        resolvedActiveModelIndex >= filteredModels.length
      ) {
        return;
      }
      e.preventDefault();
      selectModel(filteredModels[resolvedActiveModelIndex]);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      closeModelDropdown();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="ns-project-wrap" ref={modelDropdownRef}>
        <Button
          className="ns-project-btn"
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            if (modelDropdownOpen) {
              closeModelDropdown();
            } else {
              openModelDropdown();
            }
          }}
          onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              openModelDropdown();
            }
          }}
        >
          <span className="material-symbols-outlined text-lg">psychology</span>
          <span className="flex items-center gap-2 min-w-0">
            <span className="max-w-48 overflow-hidden text-ellipsis whitespace-nowrap">
              {selectedModelObj?.name ??
                (hasAnyProviderKey ? "Select Model" : "No models available")}
            </span>
            {selectedModelObj && (
              <ProviderBadge provider={selectedModelObj.owned_by} />
            )}
          </span>
          <span
            className={cn(
              "material-symbols-outlined text-md transition-transform duration-200",
              modelDropdownOpen ? "rotate-180" : "rotate-0",
            )}
          >
            expand_more
          </span>
        </Button>

        {modelDropdownOpen && (
          <div className="ns-dropdown ns-dropdown--wide">
            <TextField
              ref={modelSearchRef}
              type="text"
              className="ns-dropdown-search"
              wrapClassName="ns-dropdown-search-wrap"
              placeholder="Search model, id, provider…"
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              onKeyDown={handleModelSearchKeyDown}
            />

            <div className="ns-dropdown-scroll">
              {loading && (
                <div className="ns-dropdown-label px-3 py-2">Loading models…</div>
              )}
              {error && !loading && (
                <div className="ns-dropdown-label px-3 py-2 text-error">
                  {error}
                </div>
              )}
              {!loading && filteredModels.length === 0 && (
                <div className="ns-dropdown-label px-3 py-2 mt-4 text-center text-sm text-muted">
                  {!hasAnyProviderKey
                    ? "Add a provider in settings."
                    : !hasProviderModels
                      ? "No models available for your configured providers."
                      : `No models match \u201c${modelSearch}\u201d`}
                </div>
              )}
              <div className="ns-dropdown-section">
                {filteredModels.map((m, index) => {
                  const ctx = fmtCtx(m.context_length);
                  const price = fmtPrice(m.pricing);
                  const isActive = index === resolvedActiveModelIndex;
                  const isSelected = m.id === selectedModel;
                  return (
                    <button
                      key={m.id}
                      aria-selected={isActive}
                      ref={(node) => {
                        modelOptionRefs.current[index] = node;
                      }}
                      className={cn(
                        "ns-dropdown-item",
                        isActive && "ns-dropdown-item--active",
                        isSelected && !isActive && "ns-dropdown-item--selected",
                      )}
                      onClick={() => selectModel(m)}
                      onMouseEnter={() => setActiveModelIndex(index)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="ns-dropdown-item-name flex items-center gap-2">
                          <span className="truncate">{m.name}</span>
                          <ProviderBadge provider={m.owned_by} />
                        </div>
                        <div className="ns-dropdown-item-path max-w-full">
                          {m.id}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0 items-center">
                        {ctx && (
                          <span className="text-xxs px-2 py-px rounded-sm bg-inset text-muted font-mono">
                            {ctx}
                          </span>
                        )}
                        {price && (
                          <span className="text-xxs px-2 py-px rounded-sm bg-primary-dim text-primary font-mono">
                            {price}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {advancedOptions && onAdvancedOptionsChange && (
        <AdvancedModelOptionsButton
          provider={selectedProvider}
          value={advancedOptions}
          onChange={onAdvancedOptionsChange}
          communicationProfile={communicationProfile}
          onCommunicationProfileChange={onCommunicationProfileChange}
        />
      )}
    </div>
  );
}
