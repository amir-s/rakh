import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Button, Badge, ModalShell } from "@/components/ui";
import { TextField } from "@/components/ui";
import {
  useFilteredModels,
  fmtCtx,
  fmtPrice,
  type GatewayModel,
} from "@/agent/useModels";

/* ─────────────────────────────────────────────────────────────────────────────
     const [open, setOpen] = useState(false);
     {open && (
       <ModelPickerModal
         models={models}
         currentModelId={agent.config.model}
         onSelect={(id) => { agent.setConfig({ model: id }); setOpen(false); }}
         onClose={() => setOpen(false)}
       />
     )}
───────────────────────────────────────────────────────────────────────────── */

type ProviderBadge = "primary" | "success" | "muted";

function providerBadgeVariant(ownedBy: string): ProviderBadge {
  if (ownedBy === "anthropic") return "primary";
  if (ownedBy === "openai") return "success";
  return "muted";
}

function providerLabel(ownedBy: string): string {
  if (ownedBy === "openai") return "OpenAI";
  if (ownedBy === "anthropic") return "Anthropic";
  return "Custom";
}

interface ModelPickerModalProps {
  models: GatewayModel[];
  currentModelId: string;
  currentProfile?: string;
  onSelect: (modelId: string, profile?: string) => void;
  onClose: () => void;
}

export default function ModelPickerModal({
  models,
  currentModelId,
  currentProfile,
  onSelect,
  onClose,
}: ModelPickerModalProps) {
  const [query, setQuery] = useState("");
  const filtered = useFilteredModels(models, query);

  const initialIndex = Math.max(
    0,
    filtered.findIndex((m) => m.id === currentModelId),
  );
  const [focusedIndex, setFocusedIndex] = useState(initialIndex);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Reset focused index when query changes
  useEffect(() => {
    if (!query) {
      const idx = filtered.findIndex((m) => m.id === currentModelId);
      setFocusedIndex(Math.max(0, idx));
    } else {
      setFocusedIndex(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Scroll focused item into view
  useEffect(() => {
    const item = listRef.current?.children[focusedIndex] as
      | HTMLElement
      | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const model = filtered[focusedIndex];
        if (model) onSelect(model.id, currentProfile);
      }
    },
    [currentProfile, filtered, focusedIndex, onClose, onSelect],
  );

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label="Model Picker"
    >
      <ModalShell
        className="model-picker-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="error-modal-header">
          <span className="error-modal-title tool-modal-title">
            <span className="material-symbols-outlined text-md text-muted shrink-0">
              model_training
            </span>
            Model Picker
          </span>
          <Button
            className="error-modal-close"
            onClick={onClose}
            title="Close (Esc)"
            variant="ghost"
            size="xxs"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </Button>
        </div>

        {/* ── Search ─────────────────────────────────────────────────── */}
        <div className="model-picker-search flex flex-col gap-2">
          <TextField
            ref={searchRef}
            placeholder="Search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            startAdornment={
              <span
                className="material-symbols-outlined text-muted"
                style={{ fontSize: 18, marginLeft: 10, flexShrink: 0 }}
              >
                search
              </span>
            }
          />
        </div>

        {/* ── Model list ──────────────────────────────────────────────── */}
        <div className="model-picker-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="model-picker-empty">
              No models match your search.
            </div>
          ) : (
            filtered.map((m, idx) => (
              <ModelRow
                key={m.id}
                model={m}
                isActive={m.id === currentModelId}
                isFocused={idx === focusedIndex}
                onClick={() => onSelect(m.id, currentProfile)}
                onMouseEnter={() => setFocusedIndex(idx)}
              />
            ))
          )}
        </div>
      </ModalShell>
    </div>,
    document.body,
  );
}

/* ── Model row ────────────────────────────────────────────────────────────── */

interface ModelRowProps {
  model: GatewayModel;
  isActive: boolean;
  isFocused: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}

function ModelRow({
  model,
  isActive,
  isFocused,
  onClick,
  onMouseEnter,
}: ModelRowProps) {
  const ctx = fmtCtx(model.context_length);
  const price = fmtPrice(model.pricing);

  return (
    <button
      className={[
        "model-picker-item",
        isFocused ? "model-picker-item--focused" : "",
        isActive ? "model-picker-item--active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      type="button"
    >
      <div className="model-picker-item-main">
        <span className="model-picker-item-name">{model.name}</span>
        <Badge variant={providerBadgeVariant(model.owned_by)}>
          {providerLabel(model.owned_by)}
        </Badge>
      </div>
      <div className="model-picker-item-meta">
        <span className="model-picker-item-id">{model.id}</span>
        {ctx && <span className="model-picker-item-stat">{ctx}</span>}
        {price && <span className="model-picker-item-stat">{price}</span>}
        {isActive && (
          <span
            className="material-symbols-outlined text-primary"
            style={{ fontSize: 15, marginLeft: "auto" }}
          >
            check_circle
          </span>
        )}
      </div>
    </button>
  );
}
