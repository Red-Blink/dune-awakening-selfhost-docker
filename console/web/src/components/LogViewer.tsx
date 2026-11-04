import { useEffect, useRef } from "react";

export function LogViewer({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);

  function handleScroll() {
    const el = ref.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  }

  useEffect(() => {
    const el = ref.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      onScroll={handleScroll}
      className="log-box large"
      style={{ contentVisibility: "auto" }}
    >
      {text || "No logs loaded."}
    </pre>
  );
}
