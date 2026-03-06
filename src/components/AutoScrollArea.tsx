import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
  type CSSProperties,
} from "react";

interface AutoScrollAreaProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Distance from the bottom (px) within which auto-scroll is applied. @default 50 */
  threshold?: number;
}

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
  const [showArrow, setShowArrow] = useState(false);

  const scheduleArrowVisibility = useCallback((visible: boolean) => {
    if (arrowRafRef.current !== null) {
      cancelAnimationFrame(arrowRafRef.current);
    }
    arrowRafRef.current = requestAnimationFrame(() => {
      setShowArrow((prev) => (prev === visible ? prev : visible));
      arrowRafRef.current = null;
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowArrow(false);
  }, []);

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
        scheduleArrowVisibility(false);
      } else {
        scheduleArrowVisibility(true);
      }
    }
    prevScrollHeight.current = sh;
  }, [children, threshold, scheduleArrowVisibility]);

  // Hide the arrow once the user manually scrolls back to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const isNearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      if (isNearBottom) setShowArrow(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [threshold]);

  useEffect(
    () => () => {
      if (arrowRafRef.current !== null) {
        cancelAnimationFrame(arrowRafRef.current);
      }
    },
    [],
  );

  return (
    <div ref={scrollRef} className={className} style={style}>
      {children}
      {/* Zero-height sticky anchor at the bottom of the viewport.
          The button is absolutely positioned relative to it, so it
          overlays the content without adding any scrollable height. */}
      <div className="new-messages-anchor">
        {showArrow && (
          <button className="new-messages-marker" onClick={scrollToBottom}>
            <span className="material-symbols-outlined text-xl">
              arrow_downward
            </span>
          </button>
        )}
      </div>
      <div ref={endRef} />
    </div>
  );
}
