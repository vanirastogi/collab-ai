"use client";

import { useEffect, useRef } from "react";
import MonacoEditor, { OnMount, OnChange } from "@monaco-editor/react";
import type { Socket } from "socket.io-client";
import type * as MonacoTypes from "monaco-editor";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Issue {
  line:     number;
  severity: "error" | "warning" | "info";
  message:  string;
  fix?:     string;
}

interface CodeEditorProps {
  socket: Socket | null;
  roomId: string;
  code: string;
  language: string;
  onCodeChange: (code: string) => void;
  issues: Issue[];
}

// ─── Cursor colours ───────────────────────────────────────────────────────────

const CURSOR_COLORS = [
  "#f87171", "#fb923c", "#facc15", "#4ade80",
  "#38bdf8", "#818cf8", "#c084fc", "#f472b6", "#34d399",
];

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

// ─── Cursor style injection ───────────────────────────────────────────────────
//
// Monaco renders `afterContentClassName` as a real <span> directly in the text
// layer — the same layer that renders characters. This layer does NOT have
// overflow:hidden, so the label tag that pokes above the line is visible.
//
// Content widgets (the previous approach) are placed in a separate overlay
// container that DOES have overflow:hidden, which clipped our label.
//
// By injecting a <style> element into the editor's own container div we get:
//   • A 2px colored border-left that fills the full line height → the caret
//   • A ::after pseudo-element with content: 'name' floating above → the tag
// This is the same technique used by y-monaco and VS Code Live Share.

function injectCursorStyle(container: HTMLElement, userId: string, color: string): void {
  const id = `rc-style-${userId}`;
  if (container.querySelector(`#${id}`)) return; // already injected for this user

  const label = `user·${userId.slice(-4)}`;
  const style = document.createElement("style");
  style.id = id;
  // language=CSS
  style.textContent = `
    .rc-${userId} {
      position: absolute;
      border-left: 2px solid ${color};
      height: 100%;
      box-sizing: border-box;
      pointer-events: auto;
      cursor: default;
    }
    .rc-${userId}::after {
      content: '${label}';
      position: absolute;
      top: -22px;
      left: -2px;
      padding: 2px 6px;
      background: ${color};
      color: #fff;
      font-size: 10px;
      font-family: system-ui, -apple-system, sans-serif;
      font-weight: 600;
      border-radius: 3px 3px 3px 0;
      white-space: nowrap;
      z-index: 999;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.15s ease, transform 0.15s ease;
      pointer-events: none;
    }
    .rc-${userId}:hover::after {
      opacity: 1;
      transform: translateY(0);
    }
  `;
  container.appendChild(style);
}

function removeCursorStyle(container: HTMLElement, userId: string): void {
  const el = container.querySelector(`#rc-style-${userId}`);
  if (el) container.removeChild(el);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CodeEditor({
  socket,
  roomId,
  code,
  language,
  onCodeChange,
  issues,
}: CodeEditorProps) {
  const editorRef = useRef<MonacoTypes.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof MonacoTypes | null>(null);

  // One decoration collection per remote user — lets us update/clear per user
  // without touching anyone else's cursor.
  const cursorsRef = useRef<
    Map<string, MonacoTypes.editor.IEditorDecorationsCollection>
  >(new Map());

  // ── isRemoteChange / ev.isFlush — echo-loop prevention ───────────────────
  // ev.isFlush (primary): Monaco sets this to true when onChange fires due to
  // editor.setValue(), not user input. We skip emitting in that case.
  // isRemoteChange (secondary): belt-and-suspenders ref fallback.
  const isRemoteChange = useRef(false);

  // ── Decoration collection for issue highlights ────────────────────────────
  // createDecorationsCollection() atomically swaps the old set for a new one.
  // The ref is null until mount because it requires a live editor instance.
  const issueDecorations = useRef<MonacoTypes.editor.IEditorDecorationsCollection | null>(null);

  // ── Remote code sync ──────────────────────────────────────────────────────
  useEffect(() => {
    function onCodeUpdate(newCode: string) {
      const editor = editorRef.current;
      if (!editor) return;

      const position = editor.getPosition();
      const scrollTop = editor.getScrollTop();

      isRemoteChange.current = true;
      editor.setValue(newCode);
      isRemoteChange.current = false;

      if (position) editor.setPosition(position);
      editor.setScrollTop(scrollTop);
    }

    if (!socket) return;
    socket.on("code-change", onCodeUpdate);
    return () => { socket.off("code-change", onCodeUpdate); };
  }, [socket]);

  // ── Remote cursors ────────────────────────────────────────────────────────
  useEffect(() => {
    function onCursorMove({
      userId,
      position,
    }: {
      userId: string;
      position: { lineNumber: number; column: number };
    }) {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const color = colorForUser(userId);
      const container = editor.getContainerDomNode();

      // Inject the <style> tag once per user the first time we hear from them.
      injectCursorStyle(container, userId, color);

      const decorationSpec: MonacoTypes.editor.IModelDeltaDecoration = {
        // Zero-width range: start === end. Monaco still creates a span here,
        // and afterContentClassName attaches our cursor <span> right after it.
        range: new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        ),
        options: {
          afterContentClassName: `rc-${userId}`,
          // Prevents the decoration from growing when the local user types
          // adjacent to a remote cursor position.
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          zIndex: 99,
        },
      };

      const existing = cursorsRef.current.get(userId);
      if (existing) {
        existing.set([decorationSpec]); // update position atomically
      } else {
        const col = editor.createDecorationsCollection([decorationSpec]);
        cursorsRef.current.set(userId, col);
      }
    }

    function onCursorLeave({ userId }: { userId: string }) {
      const editor = editorRef.current;
      if (!editor) return;

      const col = cursorsRef.current.get(userId);
      if (col) {
        col.clear();
        cursorsRef.current.delete(userId);
      }
      removeCursorStyle(editor.getContainerDomNode(), userId);
    }

    if (!socket) return;
    socket.on("cursor-move", onCursorMove);
    socket.on("cursor-leave", onCursorLeave);
    return () => {
      socket.off("cursor-move", onCursorMove);
      socket.off("cursor-leave", onCursorLeave);
    };
  }, [socket]);

  // ── Issue decorations ─────────────────────────────────────────────────────
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const specs: MonacoTypes.editor.IModelDeltaDecoration[] = issues.map((issue) => ({
      range: new monaco.Range(issue.line, 1, issue.line, Number.MAX_SAFE_INTEGER),
      options: {
        isWholeLine: true,
        className:
          issue.severity === "error"   ? "monaco-error-line"
          : issue.severity === "warning" ? "monaco-warning-line"
          : "monaco-info-line",
        hoverMessage: {
          value: `**${issue.severity === "error" ? "Error" : issue.severity === "warning" ? "Warning" : "Info"}:** ${issue.message}`,
        },
        overviewRuler: {
          color: issue.severity === "error" ? "#f87171" : issue.severity === "warning" ? "#fbbf24" : "#60a5fa",
          position: monaco.editor.OverviewRulerLane.Right,
        },
      },
    }));

    issueDecorations.current?.set(specs);
  }, [issues]);

  // ── Mount ─────────────────────────────────────────────────────────────────
  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.updateOptions({
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontLigatures: true,
    });

    // Initialise the issue-decoration collection on mount.
    issueDecorations.current = editor.createDecorationsCollection([]);

    // Emit our own cursor position to peers, throttled to 50 ms.
    let timer: ReturnType<typeof setTimeout> | null = null;
    editor.onDidChangeCursorPosition((e) => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        socket?.emit("cursor-move", {
          roomId,
          position: { lineNumber: e.position.lineNumber, column: e.position.column },
        });
      }, 50);
    });
  };

  // ── onChange ──────────────────────────────────────────────────────────────
  const handleChange: OnChange = (value, ev) => {
    if (ev.isFlush) return;
    if (isRemoteChange.current) return;
    if (value === undefined) return;

    onCodeChange(value);
    socket?.emit("code-change", { roomId, code: value });
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="h-full w-full rounded-xl overflow-hidden border border-[#2d2d2d]">
      <MonacoEditor
        defaultValue={code}
        language={language}
        theme="vs-dark"
        onChange={handleChange}
        onMount={handleMount}
        options={{
          fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
          fontLigatures: true,
          fontSize: 14,
          lineHeight: 22,
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 2,
          padding: { top: 16, bottom: 16 },
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          smoothScrolling: true,
          renderWhitespace: "selection",
          automaticLayout: true,
        }}
      />
    </div>
  );
}
