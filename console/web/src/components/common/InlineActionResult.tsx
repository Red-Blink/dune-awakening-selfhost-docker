import { formatUiSentence } from "../../lib/display";

export type InlineActionResultState = {
  key: string;
  tone: "success" | "danger" | "neutral";
  text: string;
  pending?: boolean;
};

export function InlineActionResult({ result, resultKey, format = true }: { result: InlineActionResultState | null; resultKey: string; format?: boolean }) {
  if (!result || result.key !== resultKey) return null;
  return <span className="inline-action-result-wrap"><span className={`inline-action-result ${result.tone} ${result.pending ? "pending" : ""}`}>{format ? formatUiSentence(result.text, Boolean(result.pending)) : result.text}</span></span>;
}
