import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  CHAT_ATTENTION_TARGET_ATTR,
  parseChatAttentionTargetKind,
  type ChatAttentionTargetKind,
} from "./autoScrollAttention";

interface AutoScrollAreaProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Distance from the bottom (px) within which auto-scroll is applied. @default 50 */
  threshold?: number;
}

interface OffscreenAttentionTarget {
  target: HTMLElement | null;
  kind: ChatAttentionTargetKind | null;
}

interface OffscreenAttentionState {
  above: OffscreenAttentionTarget;
  below: OffscreenAttentionTarget;
}

const EMPTY_ATTENTION_TARGET: OffscreenAttentionTarget = {
  target: null,
  kind: null,
};

const EMPTY_ATTENTION_STATE: OffscreenAttentionState = {
  above: EMPTY_ATTENTION_TARGET,
  below: EMPTY_ATTENTION_TARGET,
};

/**
 * A scrollable container that:
 * - Automatically scrolls to the bottom when content grows and the user is
 *   already near the bottom.
 * - Shows a sticky "scroll to bottom" arrow when content grows while the user
 *   is scrolled up. The arrow is hidden again once the user scrolls back down.
 *
 * Children are rendered as direct flex children so that any `gap` / layout
 * styles applied via `className` work without an extra wrapper.
 */
export default function AutoScrollArea({
  children,
  className,
  style,
  threshold = 50,
}: AutoScrollAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const prevScrollHeight = useRef(0);
  const arrowRafRef = useRef<number | null>(null);
  const attentionRafRef = useRef<number | null>(null);
  const [showNewContentArrow, setShowNewContentArrow] = useState(false);
  const [attentionState, setAttentionState] =
    useState<OffscreenAttentionState>(EMPTY_ATTENTION_STATE);

  const scheduleNewContentArrow = useCallback((visible: boolean) => {
    if (arrowRafRef.current !== null) {
      cancelAnimationFrame(arrowRafRef.current);
    }
    arrowRafRef.current = requestAnimationFrame(() => {
      setShowNewContentArrow((prev) => (prev === visible ? prev : visible));
      arrowRafRef.current = null;
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowNewContentArrow(false);
  }, []);

  const resolveOffscreenAttention = useCallback((): OffscreenAttentionState => {
    const el = scrollRef.current;
    if (!el) return EMPTY_ATTENTION_STATE;

    const containerRect = el.getBoundingClientRect();
    const topBoundary = containerRect.top + 8;
    const bottomBoundary = containerRect.bottom - 8;
    const targets = Array.from(
      el.querySelectorAll<HTMLElement>(`[${CHAT_ATTENTION_TARGET_ATTR}]`),
    );

    let nearestAbove = EMPTY_ATTENTION_TARGET;
    let nearestAboveDistance = Number.POSITIVE_INFINITY;
    let nearestBelow = EMPTY_ATTENTION_TARGET;
    let nearestBelowDistance = Number.POSITIVE_INFINITY;

    for (const target of targets) {
      const kind = parseChatAttentionTargetKind(
        target.getAttribute(CHAT_ATTENTION_TARGET_ATTR) ?? undefined,
      );
      if (kind == null) continue;

      const rect = target.getBoundingClientRect();
      if (rect.bottom < topBoundary) {
        const distance = topBoundary - rect.bottom;
        if (distance < nearestAboveDistance) {
          nearestAboveDistance = distance;
          nearestAbove = { target, kind };
        }
        continue;
      }

      if (rect.top > bottomBoundary) {
        const distance = rect.top - bottomBoundary;
        if (distance < nearestBelowDistance) {
          nearestBelowDistance = distance;
          nearestBelow = { target, kind };
        }
      }
    }

    return { above: nearestAbove, below: nearestBelow };
  }, []);

  const scheduleAttentionUpdate = useCallback(() => {
    if (attentionRafRef.current !== null) return;
    attentionRafRef.current = requestAnimationFrame(() => {
      attentionRafRef.current = null;
      const nextState = resolveOffscreenAttention();
      setAttentionState((prev) => {
        if (
          prev.above.target === nextState.above.target &&
          prev.above.kind === nextState.above.kind &&
          prev.below.target === nextState.below.target &&
          prev.below.kind === nextState.below.kind
        ) {
          return prev;
        }
        return nextState;
      });
    });
  }, [resolveOffscreenAttention]);

  const scrollToAttention = useCallback(
    (direction: "up" | "down") => {
      const nextTarget =
        direction === "up" ? attentionState.above.target : attentionState.below.target;
      if (nextTarget) {
        nextTarget.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (direction === "down") {
        scrollToBottom();
      }
    },
    [attentionState.above.target, attentionState.below.target, scrollToBottom],
  );

  // Runs after every render. Detects any scrollHeight growth (new messages,
  // streaming text, tool output, etc.) and either auto-scrolls or shows the
  // arrow indicator.
  //
  // Crucially, we use prevScrollHeight (the height BEFORE this render) together
  // with the unchanged scrollTop to reconstruct where the user was before the
  // new content arrived. Checking isNearBottom() after the DOM update would
  // give a false negative because the new content already pushed scrollHeight up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sh = el.scrollHeight;
    if (sh > prevScrollHeight.current) {
      const wasNearBottom =
        prevScrollHeight.current - el.scrollTop - el.clientHeight < threshold;
      if (wasNearBottom) {
        endRef.current?.scrollIntoView({ behavior: "smooth" });
        scheduleNewContentArrow(false);
      } else {
        scheduleNewContentArrow(true);
      }
    }
    prevScrollHeight.current = sh;
    scheduleAttentionUpdate();
  }, [children, threshold, scheduleAttentionUpdate, scheduleNewContentArrow]);

  // Hide the bottom arrow once the user scrolls back down and refresh the
  // off-screen attention targets in both directions.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const isNearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (isNearBottom) setShowNewContentArrow(false);
      scheduleAttentionUpdate();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleAttentionUpdate);
    scheduleAttentionUpdate();
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", scheduleAttentionUpdate);
    };
  }, [threshold, scheduleAttentionUpdate]);

  useEffect(
    () => () => {
      if (arrowRafRef.current !== null) {
        cancelAnimationFrame(arrowRafRef.current);
      }
      if (attentionRafRef.current !== null) {
        cancelAnimationFrame(attentionRafRef.current);
      }
    },
    [],
  );

  const showUpArrow = attentionState.above.target != null;
  const showDownArrow =
    attentionState.below.target != null || showNewContentArrow;
  const showUpDot = attentionState.above.target != null;
  const showDownDot = attentionState.below.target != null;

  return (
    <div ref={scrollRef} className={className} style={style}>
      <div className="new-messages-anchor new-messages-anchor--top">
        {showUpArrow && (
          <button
            type="button"
            className="new-messages-marker new-messages-marker--top"
            onClick={() => scrollToAttention("up")}
            title={
              attentionState.above.kind === "approval"
                ? "Jump to the previous approval request"
                : "Jump to the previous action"
            }
            aria-label={
              attentionState.above.kind === "approval"
                ? "Jump to the previous approval request"
                : "Jump to the previous action"
            }
          >
            <span className="material-symbols-outlined text-xl">
              arrow_upward
            </span>
            {showUpDot && <span className="new-messages-marker__dot" aria-hidden="true" />}
          </button>
        )}
      </div>
      {children}
      {/* Zero-height sticky anchor at the bottom of the viewport.
          The button is absolutely positioned relative to it, so it
          overlays the content without adding any scrollable height. */}
      <div className="new-messages-anchor new-messages-anchor--bottom">
        {showDownArrow && (
          <button
            type="button"
            className="new-messages-marker new-messages-marker--bottom"
            onClick={() => scrollToAttention("down")}
            title={
              attentionState.below.kind === "approval"
                ? "Jump to the next approval request"
                : attentionState.below.kind === "cta"
                  ? "Jump to the next action"
                  : "Scroll to the newest messages"
            }
            aria-label={
              attentionState.below.kind === "approval"
                ? "Jump to the next approval request"
                : attentionState.below.kind === "cta"
                  ? "Jump to the next action"
                  : "Scroll to the newest messages"
            }
          >
            <span className="material-symbols-outlined text-xl">
              arrow_downward
            </span>
            {showDownDot && (
              <span className="new-messages-marker__dot" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      <div ref={endRef} />
    </div>
  );
}
