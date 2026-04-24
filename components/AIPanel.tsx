"use client";

// ─── What is getReader() and how does chunk-by-chunk reading work? ────────────
//
// Every Response from fetch() exposes a `body` property that is a ReadableStream.
// Calling response.body.getReader() locks that stream and returns a
// ReadableStreamDefaultReader — the object you use to pull data out of it.
//
// The reader has one key method:
//   const { done, value } = await reader.read();
//
//   • `value`  — a Uint8Array of raw bytes for this chunk. The size is
//                determined by the network, not by you: one read() call might
//                return 3 bytes, the next 400. You never know in advance.
//   • `done`   — true when the stream is closed (server called controller.close()).
//
// You run this in a while(true) loop, breaking when done is true. Each
// iteration yields to the event loop (the await), so the UI stays responsive
// and you can call setState() to update what the user sees in real time.
//
// Because chunks are raw bytes, you need a TextDecoder to convert them back
// to strings. The `{ stream: true }` option is important: it tells the decoder
// to hold any incomplete multi-byte UTF-8 sequence at the end of a chunk and
// prepend it to the next chunk, rather than replacing it with the replacement
// character (U+FFFD). Without it, emoji or non-ASCII characters that straddle
// a chunk boundary would be corrupted.
//
// Our /api/review route formats each token as an SSE line:
//   data: "token"\n\n
// So after decoding bytes to string we split on newlines, look for lines
// starting with "data: ", strip the prefix, and JSON.parse the token value.

import { useEffect, useRef, useState } from "react";
import type { Issue } from "@/components/CodeEditor";
import type { DrawObject } from "@/app/api/draw/route";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReviewResult {
  summary:     string;
  issues:      Issue[];
  score:       number;
  suggestions: string[];
}

type ReviewStatus = "idle" | "streaming" | "done" | "error";
type Tab = "review" | "whiteboard";

interface AIPanelProps {
  code:            string;
  language:        string;
  onIssuesFound:   (issues: Issue[]) => void;
  onDrawObjects:   (objects: DrawObject[]) => void;
  /** Raw Fabric.js canvas JSON — used to extract labels for AI context. */
  whiteboardData?: string;
  /** Incremented by the parent each time an auto-review should fire. */
  autoTrigger?:    number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 8) return "text-green-400";
  if (score >= 5) return "text-amber-400";
  return "text-red-400";
}

function scoreBg(score: number): string {
  if (score >= 8) return "bg-green-400/10 border-green-400/30";
  if (score >= 5) return "bg-amber-400/10 border-amber-400/30";
  return "bg-red-400/10 border-red-400/30";
}

function severityBadge(severity: Issue["severity"]): string {
  switch (severity) {
    case "error":   return "bg-red-500/20 text-red-400 border-red-500/30";
    case "warning": return "bg-amber-500/20 text-amber-400 border-amber-500/30";
    case "info":    return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  }
}

// ─── Canvas label extractor ───────────────────────────────────────────────────
//
// Walks the Fabric.js canvas JSON and collects every piece of visible text:
//   • Standalone FabricText / IText / Textbox objects (placed with the T tool)
//   • FabricText children inside Group objects (AI-drawn labeled boxes)
//
// The result is a plain-English summary we inject into the AI prompt so it
// knows what is already on the canvas before executing a draw command.

type FabricObj = {
  type:     string;
  text?:    string;
  left?:    number;
  top?:     number;
  objects?: FabricObj[];
};

function extractCanvasLabels(whiteboardData?: string): string {
  if (!whiteboardData) return "none";
  try {
    const canvas = JSON.parse(whiteboardData) as { objects?: FabricObj[] };
    if (!Array.isArray(canvas.objects) || canvas.objects.length === 0) return "none";

    const TEXT_TYPES = new Set(["FabricText", "IText", "Textbox", "Text"]);
    const items: string[] = [];

    for (const obj of canvas.objects) {
      const left = Math.round(obj.left ?? 0);
      const top  = Math.round(obj.top  ?? 0);

      if (TEXT_TYPES.has(obj.type)) {
        const text = obj.text?.trim() ?? "";
        // Skip the default "Text" placeholder inserted when the tool is first clicked
        if (text && text !== "Text") {
          items.push(`"${text}" at (${left},${top})`);
        }
      }

      // Groups created by the AI draw tool contain a Rect + FabricText child.
      // The group's left/top is its center (originX/originY: "center").
      if (obj.type === "Group" && Array.isArray(obj.objects)) {
        for (const child of obj.objects) {
          if (TEXT_TYPES.has(child.type)) {
            const text = child.text?.trim() ?? "";
            if (text) {
              items.push(`"${text}" at (${left},${top}) [box]`);
            }
          }
        }
      }
    }

    return items.length > 0 ? items.join("; ") : "none";
  } catch {
    return "none";
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AIPanel({
  code,
  language,
  onIssuesFound,
  onDrawObjects,
  whiteboardData,
  autoTrigger,
}: AIPanelProps) {
  const [tab,         setTab]         = useState<Tab>("review");
  const [status,      setStatus]      = useState<ReviewStatus>("idle");
  const [raw,         setRaw]         = useState("");
  const [result,      setResult]      = useState<ReviewResult | null>(null);
  const [error,       setError]       = useState("");
  const [wbCommand,   setWbCommand]   = useState("");
  const [wbLoading,   setWbLoading]   = useState(false);
  const [wbHistory,   setWbHistory]   = useState<string[]>([]);  // commands that succeeded
  const [wbError,     setWbError]     = useState("");

  // AbortController ref lets us cancel an in-flight request if the user
  // clicks "Review" again before the previous one finishes.
  const abortRef = useRef<AbortController | null>(null);

  // ── Auto-review trigger ────────────────────────────────────────────────────
  // The parent increments autoTrigger after the debounce fires. Skip 0 (mount).
  useEffect(() => {
    if (!autoTrigger) return;
    startReview();
  }, [autoTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Stream reader ──────────────────────────────────────────────────────────
  async function startReview() {
    if (!code.trim()) return;

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("streaming");
    setRaw("");
    setResult(null);
    setError("");

    try {
      const res = await fetch("/api/review", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code, language }),
        signal:  controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      // ── getReader() ─────────────────────────────────────────────────────
      // Locks the stream to this reader. Each read() call suspends until the
      // next chunk of bytes arrives from the network, then resumes.
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();    // reused across all chunks
      let   accumulated = "";
      // lineBuffer holds any incomplete SSE line that was cut mid-chunk.
      let   lineBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // { stream: true } — hold incomplete multi-byte chars for next chunk
        const text = decoder.decode(value, { stream: true });

        // Prepend whatever was left over from the previous chunk
        const lines = (lineBuffer + text).split("\n");

        // The last element may be an incomplete line — save it for next iter
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          const payload = line.slice(6); // strip "data: "
          if (payload === "[DONE]") break;

          try {
            const token = JSON.parse(payload);
            if (typeof token === "string") {
              accumulated += token;
              setRaw(accumulated);       // live update as tokens arrive
            }
          } catch {
            // Malformed SSE line — skip silently
          }
        }
      }

      // ── Parse the complete JSON response ──────────────────────────────────
      const parsed: ReviewResult = JSON.parse(accumulated);
      setResult(parsed);
      setStatus("done");
      onIssuesFound(parsed.issues ?? []);

    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setStatus("idle");
        return;
      }
      setError(err instanceof Error ? err.message : "Review failed");
      setStatus("error");
    }
  }

  function cancelReview() {
    abortRef.current?.abort();
    setStatus("idle");
  }

  // ── Whiteboard draw ────────────────────────────────────────────────────────
  async function handleDraw() {
    if (!wbCommand.trim() || wbLoading) return;
    setWbLoading(true);
    setWbError("");
    try {
      // Extract all visible text labels from the live canvas JSON so the AI
      // knows about everything on the board — both what it drew earlier and
      // shapes/labels the user added manually with the drawing tools.
      const canvasContext = extractCanvasLabels(whiteboardData);
      const res = await fetch("/api/draw", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ command: wbCommand, context: canvasContext }),
      });
      const { objects, error: apiError } = await res.json();
      if (apiError) throw new Error(apiError);
      if (!Array.isArray(objects) || objects.length === 0) {
        throw new Error("No objects returned — try rephrasing the command.");
      }
      onDrawObjects(objects);
      // Track box labels added this round for future context
      const newLabels = objects
        .filter((o: DrawObject) => o.type === "box")
        .map((o: DrawObject) => (o as Extract<DrawObject, { type: "box" }>).label);
      setWbHistory((h) => [...h, ...newLabels]);
      setWbCommand("");
    } catch (err) {
      setWbError(err instanceof Error ? err.message : "Failed");
    } finally {
      setWbLoading(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full text-sm">

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex border-b border-[#2d2d2d]">
        <PanelTab active={tab === "review"}     onClick={() => setTab("review")}>     Code Review</PanelTab>
        <PanelTab active={tab === "whiteboard"} onClick={() => setTab("whiteboard")}> Whiteboard AI</PanelTab>
      </div>

      {/* ── Code Review tab ─────────────────────────────────────────────── */}
      {tab === "review" && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">

          {/* Action bar */}
          <div className="flex-shrink-0 p-3 border-b border-[#2d2d2d] flex gap-2">
            <button
              onClick={startReview}
              disabled={status === "streaming" || !code.trim()}
              className="flex-1 py-2 rounded-lg bg-white text-black text-xs font-semibold hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {status === "streaming" ? "Reviewing…" : "Review code"}
            </button>
            {status === "streaming" && (
              <button
                onClick={cancelReview}
                className="px-3 py-2 rounded-lg border border-[#3f3f46] text-xs text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 p-3 space-y-4">

            {/* Idle state */}
            {status === "idle" && !result && (
              <p className="text-xs text-gray-600 text-center pt-6 leading-relaxed">
                Click <span className="text-gray-400">"Review code"</span> to get AI feedback on the code in the editor.
              </p>
            )}

            {/* Streaming — show raw text with blinking cursor */}
            {status === "streaming" && (
              <div className="bg-[#28282b] rounded-lg p-3">
                <p className="text-xs text-gray-300 font-mono leading-relaxed whitespace-pre-wrap break-words">
                  {raw}
                  {/* Blinking cursor */}
                  <span className="inline-block w-1.5 h-3.5 bg-gray-400 ml-0.5 align-middle animate-pulse" />
                </p>
              </div>
            )}

            {/* Error */}
            {status === "error" && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                <p className="text-xs text-red-400">{error}</p>
              </div>
            )}

            {/* Done — structured result */}
            {result && status === "done" && (
              <div className="space-y-4">

                {/* Score */}
                <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${scoreBg(result.score)}`}>
                  <span className={`text-3xl font-bold tabular-nums ${scoreColor(result.score)}`}>
                    {result.score}
                  </span>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500">Score</p>
                    <p className="text-xs text-gray-300 leading-snug mt-0.5">{result.summary}</p>
                  </div>
                </div>

                {/* Issues */}
                {result.issues?.length > 0 && (
                  <section>
                    <SectionLabel>Issues</SectionLabel>
                    <div className="space-y-2">
                      {result.issues.map((issue, i) => (
                        <div key={i} className="bg-[#28282b] rounded-lg p-3 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wide ${severityBadge(issue.severity)}`}>
                              {issue.severity}
                            </span>
                            <span className="text-[10px] text-gray-500 font-mono">
                              line {issue.line}
                            </span>
                          </div>
                          <p className="text-xs text-gray-300 leading-snug">{issue.message}</p>
                          {issue.fix && (
                            <p className="text-[11px] text-gray-500 leading-snug">
                              <span className="text-green-500">Fix: </span>{issue.fix}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Suggestions */}
                {result.suggestions?.length > 0 && (
                  <section>
                    <SectionLabel>Suggestions</SectionLabel>
                    <ul className="space-y-1.5">
                      {result.suggestions.map((s, i) => (
                        <li key={i} className="flex gap-2 text-xs text-gray-400 leading-snug">
                          <span className="text-gray-600 flex-shrink-0">→</span>
                          {s}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Whiteboard AI tab ───────────────────────────────────────────── */}
      {tab === "whiteboard" && (
        <div className="flex-1 flex flex-col min-h-0">

          {/* Command input */}
          <div className="flex-shrink-0 p-3 border-b border-[#2d2d2d] space-y-2">
            <textarea
              value={wbCommand}
              onChange={(e) => setWbCommand(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleDraw(); } }}
              placeholder={'e.g. "Add a Redis cache between Server and Database"'}
              rows={3}
              className="w-full bg-[#28282b] text-gray-300 text-xs rounded-lg px-3 py-2 border border-[#3f3f46] focus:outline-none focus:border-gray-500 resize-none placeholder-gray-600 leading-relaxed"
            />
            <button
              onClick={handleDraw}
              disabled={wbLoading || !wbCommand.trim()}
              className="w-full py-2 rounded-lg bg-white text-black text-xs font-semibold hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {wbLoading ? "Drawing…" : "Draw on whiteboard"}
            </button>
            {wbError && (
              <p className="text-[11px] text-red-400 leading-snug">{wbError}</p>
            )}
          </div>

          {/* History of drawn commands */}
          <div className="flex-1 overflow-y-auto p-3">
            {wbHistory.length > 0 ? (
              <div className="space-y-1.5">
                <SectionLabel>Added to canvas</SectionLabel>
                {wbHistory.map((label, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-gray-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                    {label}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600 text-center pt-6 leading-relaxed">
                Type a command and press Enter — AI will draw boxes and arrows on the whiteboard.
              </p>
            )}
          </div>

        </div>
      )}

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PanelTab({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 text-xs font-medium transition-colors border-b-2 ${
        active
          ? "text-white border-white"
          : "text-gray-500 border-transparent hover:text-gray-300"
      }`}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
      {children}
    </p>
  );
}
