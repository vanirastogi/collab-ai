"use client";

import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
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

export interface CodeEditorHandle {
  /** Seed the Yjs document if it is empty (called with DB code on join). */
  setEditorValue: (value: string) => void;
}

interface CodeEditorProps {
  socket:       Socket | null;
  roomId:       string;
  code:         string;
  language:     string;
  onCodeChange: (code: string) => void;
  issues:       Issue[];
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

function injectCursorStyle(container: HTMLElement, userId: string, color: string): void {
  const id = `rc-style-${userId}`;
  if (container.querySelector(`#${id}`)) return;
  const label = `user·${userId.slice(-4)}`;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    .rc-${userId} {
      position: absolute; border-left: 2px solid ${color};
      height: 100%; box-sizing: border-box;
      pointer-events: auto; cursor: default;
    }
    .rc-${userId}::after {
      content: '${label}';
      position: absolute; top: -22px; left: -2px;
      padding: 2px 6px; background: ${color}; color: #fff;
      font-size: 10px; font-family: system-ui, -apple-system, sans-serif;
      font-weight: 600; border-radius: 3px 3px 3px 0;
      white-space: nowrap; z-index: 999;
      opacity: 0; transform: translateY(4px);
      transition: opacity 0.15s ease, transform 0.15s ease;
      pointer-events: none;
    }
    .rc-${userId}:hover::after { opacity: 1; transform: translateY(0); }
  `;
  container.appendChild(style);
}

function removeCursorStyle(container: HTMLElement, userId: string): void {
  const el = container.querySelector(`#rc-style-${userId}`);
  if (el) container.removeChild(el);
}

// ─── Component ────────────────────────────────────────────────────────────────

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({
  socket,
  roomId,
  code,
  language,
  onCodeChange,
  issues,
}, ref) {
  const editorRef    = useRef<MonacoTypes.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef    = useRef<typeof MonacoTypes | null>(null);
  const cursorsRef   = useRef<Map<string, MonacoTypes.editor.IEditorDecorationsCollection>>(new Map());
  const issueDecorations = useRef<MonacoTypes.editor.IEditorDecorationsCollection | null>(null);

  // Yjs refs — set once the provider syncs in handleMount
  const ytextRef          = useRef<import("yjs").Text | null>(null);
  const pendingInitialCode = useRef<string | null>(null);
  const yjsCleanupRef     = useRef<(() => void) | null>(null);

  // ── Seed Yjs from DB/socket room-state ───────────────────────────────────
  // Called by the parent after DB or socket provides initial code.
  // Only inserts if the Yjs document is empty so live data is never overwritten.
  useImperativeHandle(ref, () => ({
    setEditorValue(value: string) {
      if (!value) return;
      const ytext = ytextRef.current;
      if (ytext !== null) {
        if (ytext.toString() === "") ytext.insert(0, value);
      } else {
        // Yjs not connected yet — store and apply after sync
        pendingInitialCode.current = value;
      }
    },
  }));

  // Cleanup Yjs on unmount
  useEffect(() => () => { yjsCleanupRef.current?.(); }, []);

  // ── Remote cursors (socket) ───────────────────────────────────────────────
  useEffect(() => {
    function onCursorMove({ userId, position }: {
      userId: string; position: { lineNumber: number; column: number };
    }) {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const color = colorForUser(userId);
      injectCursorStyle(editor.getContainerDomNode(), userId, color);

      const spec: MonacoTypes.editor.IModelDeltaDecoration = {
        range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
        options: {
          afterContentClassName: `rc-${userId}`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          zIndex: 99,
        },
      };
      const existing = cursorsRef.current.get(userId);
      if (existing) {
        existing.set([spec]);
      } else {
        cursorsRef.current.set(userId, editor.createDecorationsCollection([spec]));
      }
    }

    function onCursorLeave({ userId }: { userId: string }) {
      const editor = editorRef.current;
      if (!editor) return;
      cursorsRef.current.get(userId)?.clear();
      cursorsRef.current.delete(userId);
      removeCursorStyle(editor.getContainerDomNode(), userId);
    }

    if (!socket) return;
    socket.on("cursor-move",  onCursorMove);
    socket.on("cursor-leave", onCursorLeave);
    return () => {
      socket.off("cursor-move",  onCursorMove);
      socket.off("cursor-leave", onCursorLeave);
    };
  }, [socket]);

  // ── Issue decorations ─────────────────────────────────────────────────────
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    issueDecorations.current?.set(issues.map((issue) => ({
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
    })));
  }, [issues]);

  // ── Mount ─────────────────────────────────────────────────────────────────
  const handleMount: OnMount = async (editor, monaco) => {
    editorRef.current  = editor;
    monacoRef.current  = monaco;
    issueDecorations.current = editor.createDecorationsCollection([]);

    editor.updateOptions({
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontLigatures: true,
    });

    // ── Cursor emit (socket) ────────────────────────────────────────────────
    let cursorTimer: ReturnType<typeof setTimeout> | null = null;
    editor.onDidChangeCursorPosition((e) => {
      if (cursorTimer) return;
      cursorTimer = setTimeout(() => {
        cursorTimer = null;
        socket?.emit("cursor-move", {
          roomId,
          position: { lineNumber: e.position.lineNumber, column: e.position.column },
        });
      }, 50);
    });

    // ── Yjs setup (dynamic import — runs only in browser) ──────────────────
    const [{ Doc }, { WebsocketProvider }, { MonacoBinding }] = await Promise.all([
      import("yjs"),
      import("y-websocket"),
      import("y-monaco"),
    ]);

    const wsUrl = (process.env.NEXT_PUBLIC_SERVER_URL ?? "ws://localhost:3001")
      .replace(/^http/, "ws");

    const ydoc    = new Doc();
    const ytext   = ydoc.getText("monaco");
    const provider = new WebsocketProvider(`${wsUrl}/yjs`, roomId, ydoc);

    ytextRef.current = ytext;

    // Once initial sync completes, seed from DB/socket if Yjs is still empty
    provider.on("sync", () => {
      const pending = pendingInitialCode.current;
      if (pending && ytext.toString() === "") {
        ytext.insert(0, pending);
        pendingInitialCode.current = null;
      }
    });

    // Bind Yjs ↔ Monaco — handles all CRDT conflict resolution automatically
    const binding = new MonacoBinding(
      ytext,
      editor.getModel()!,
      new Set([editor]),
      provider.awareness,
    );

    // Notify parent of code changes (for save, AI review, run)
    ytext.observe(() => {
      onCodeChange(ytext.toString());
    });

    yjsCleanupRef.current = () => {
      binding.destroy();
      provider.destroy();
      ydoc.destroy();
    };
  };

  // ── onChange — only for localStorage / parent state, not for sync ─────────
  // Yjs handles sync. We still need onChange to tell the parent the code changed.
  // But ytext.observe above already does that, so handleChange just avoids
  // double-calling onCodeChange for local edits (ytext.observe fires for all).
  const handleChange: OnChange = (_value, ev) => {
    if (ev.isFlush) return; // Monaco internal flush, not user input
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
});

export default CodeEditor;
