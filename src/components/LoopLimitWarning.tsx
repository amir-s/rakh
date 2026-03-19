import type { AgentLoopWarning } from "@/agent/types";
import { Button } from "@/components/ui";

interface LoopLimitWarningProps {
  warning: AgentLoopWarning;
  onDismiss: () => void;
}

export default function LoopLimitWarning({
  warning,
  onDismiss,
}: LoopLimitWarningProps) {
  return (
    <div className="loop-limit-warning">
      <div className="loop-limit-warning__copy">
        <span className="material-symbols-outlined loop-limit-warning__icon">
          warning
        </span>
        <div className="loop-limit-warning__text">
          <div className="loop-limit-warning__title">
            Long-running loop detected
          </div>
          <div className="loop-limit-warning__description">
            This run has reached iteration {warning.currentIteration}. The
            warning threshold is {warning.warningThreshold} and the configured
            hard stop is {warning.hardLimit}.
          </div>
        </div>
      </div>
      <Button type="button" variant="ghost" size="xxs" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
