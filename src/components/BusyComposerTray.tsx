import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import type { AgentQueueState } from "@/agent/types";

export interface BusyComposerQueueItem {
  id: string;
  content: string;
}

interface BusyComposerTrayProps {
  queuedItems: BusyComposerQueueItem[];
  queueState: AgentQueueState;
  onSendQueuedNow?: (id: string) => void;
  onResumeQueue?: () => void;
  onClearQueuedItems?: () => void;
  onRemoveQueuedItem?: (id: string) => void;
}

interface BusyComposerRowProps {
  label: string;
  preview: string;
  actions: ReactNode;
}

function BusyComposerRow({ label, preview, actions }: BusyComposerRowProps) {
  return (
    <div className="busy-composer-row">
      <div className="busy-composer-row__label-wrap">
        <span className="busy-composer-row__label">{label}</span>
      </div>

      <div className="busy-composer-row__preview-wrap">
        <span className="busy-composer-row__preview">{preview}</span>
      </div>

      <div className="busy-composer-row__actions">{actions}</div>
    </div>
  );
}

export default function BusyComposerTray({
  queuedItems,
  queueState,
  onSendQueuedNow,
  onResumeQueue,
  onClearQueuedItems,
  onRemoveQueuedItem,
}: BusyComposerTrayProps) {
  const showRows = queuedItems.length > 0;

  if (!showRows) return null;

  return (
    <div className="busy-composer-strip">
      {queueState === "paused" && queuedItems.length > 0 ? (
        <BusyComposerRow
          label="Paused"
          preview={
            queuedItems.length === 1
              ? "1 queued note is waiting."
              : `${queuedItems.length} queued notes are waiting.`
          }
          actions={
            <>
              {onResumeQueue ? (
                <Button variant="secondary" size="xxs" onClick={onResumeQueue}>
                  Resume
                </Button>
              ) : null}
              {onClearQueuedItems ? (
                <Button variant="ghost" size="xxs" onClick={onClearQueuedItems}>
                  Clear
                </Button>
              ) : null}
            </>
          }
        />
      ) : null}

      {queuedItems.map((item, index) => (
        <BusyComposerRow
          key={item.id}
          label={`Queued ${index + 1}`}
          preview={item.content}
          actions={
            <>
              {onSendQueuedNow ? (
                <Button
                  variant="secondary"
                  size="xxs"
                  onClick={() => onSendQueuedNow(item.id)}
                >
                  Send now
                </Button>
              ) : null}
              {onRemoveQueuedItem ? (
                <button
                  type="button"
                  className="busy-composer-row__dismiss"
                  aria-label={`Remove queued note ${index + 1}`}
                  onClick={() => onRemoveQueuedItem(item.id)}
                >
                  <span className="material-symbols-outlined text-base" aria-hidden="true">
                    close
                  </span>
                </button>
              ) : null}
            </>
          }
        />
      ))}
    </div>
  );
}
