"use client";

/**
 * Why dynamic import for Fabric.js?
 *
 * Fabric reads `window`, `document`, and `HTMLCanvasElement` the moment the
 * module is evaluated — not lazily inside a class or function. In Next.js,
 * every page is first rendered on the server (Node.js), where none of those
 * browser globals exist. A top-level `import { Canvas } from 'fabric'` would
 * crash the server with "window is not defined" before any React code runs.
 *
 * By moving the import inside a useEffect, we guarantee it only executes in
 * the browser, after hydration, when the real DOM is available. The rest of
 * the component — props, state, socket listeners — can be parsed and rendered
 * server-side safely because they never touch the Fabric module directly.
 */

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
// Type-only import is safe: the TS compiler strips it at build time.
import type { Canvas as FabricCanvas, PencilBrush as FabricPencilBrush } from "fabric";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhiteboardProps {
  socket: Socket;
  roomId: string;
  initialData?: string;
}

type Tool = "draw" | "select";

// ─── Constants ────────────────────────────────────────────────────────────────

const PRESET_COLORS = [
  "#ffffff", "#f87171", "#fb923c", "#facc15",
  "#4ade80", "#38bdf8", "#818cf8", "#f472b6",
];

const BG = "#18181b";

// ─── Component ────────────────────────────────────────────────────────────────

export default function Whiteboard({ socket, roomId, initialData }: WhiteboardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasElRef  = useRef<HTMLCanvasElement>(null);
  const fabricRef    = useRef<FabricCanvas | null>(null);
  const brushRef     = useRef<FabricPencilBrush | null>(null);

  // ── isReceiving ref ────────────────────────────────────────────────────────
  // Same echo-loop prevention pattern as CodeEditor.
  // When we apply a remote update via loadFromJSON(), that triggers
  // object:added/object:modified events on the canvas. Without this flag we
  // would re-emit the same state back to the server, which would bounce it
  // back to the peer, creating an infinite loop.
  // We use a ref (not state) so the flip is synchronous and causes no re-render.
  const isReceiving = useRef(false);

  const [tool,      setTool]      = useState<Tool>("draw");
  const [color,     setColor]     = useState("#ffffff");
  const [brushSize, setBrushSize] = useState(4);

  // Holds the Promise returned by the previous fc.dispose() call.
  // In Fabric v7 dispose() is async — without awaiting it, StrictMode's
  // second effect run tries to initialise the same <canvas> element before
  // Fabric has finished deregistering it, triggering "canvas already
  // initialised". Storing the promise lets the next init() await it first.
  const disposalRef = useRef<Promise<void>>(Promise.resolve());

  // ── Canvas init ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasElRef.current || !containerRef.current) return;

    // Each effect closure gets its own `cancelled` flag. If StrictMode runs
    // cleanup before this async init finishes, cancelled flips to true and
    // every await checkpoint bails out — preventing a race with the next run.
    let cancelled = false;

    async function init() {
      // Wait for any in-progress disposal from the previous cleanup.
      await disposalRef.current;
      if (cancelled) return;

      // ← The dynamic import that keeps Fabric out of SSR. See module JSDoc.
      const { Canvas, PencilBrush } = await import("fabric");
      if (cancelled) return;

      const { clientWidth: w, clientHeight: h } = containerRef.current!;

      const fc = new Canvas(canvasElRef.current!, {
        backgroundColor: BG,
        isDrawingMode: true,
        width:  w || 900,
        height: h || 600,
        selection: false,
      });

      fabricRef.current = fc;

      const brush = new PencilBrush(fc);
      brush.color = color;
      brush.width = brushSize;
      fc.freeDrawingBrush = brush;
      brushRef.current = brush;

      // Late-joiner: load the room's existing drawing state.
      if (initialData) {
        isReceiving.current = true;
        try {
          await fc.loadFromJSON(JSON.parse(initialData));
          fc.requestRenderAll();
        } finally {
          isReceiving.current = false;
        }
      }

      // ── Emit local changes ─────────────────────────────────────────────────
      function emitChange() {
        if (isReceiving.current) return;
        socket.emit("whiteboard-change", {
          roomId,
          whiteboardData: JSON.stringify(fc.toJSON()),
        });
      }

      fc.on("object:added",    emitChange);
      fc.on("object:modified", emitChange);
      fc.on("object:removed",  emitChange);
    }

    init();

    return () => {
      cancelled = true;
      if (fabricRef.current) {
        // Store the async disposal promise so the next init() can await it.
        disposalRef.current = fabricRef.current.dispose();
        fabricRef.current = null;
        brushRef.current  = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // ↑ Intentionally empty: canvas is initialised once. initialData is only
  //   needed on first mount (for users joining a room that already has drawing).

  // ── Incoming whiteboard updates ────────────────────────────────────────────
  useEffect(() => {
    async function onWhiteboardChange(data: string) {
      const fc = fabricRef.current;
      if (!fc) return;

      // Empty string == peer clicked Clear
      if (!data) {
        fc.clear();
        fc.backgroundColor = BG;
        fc.requestRenderAll();
        return;
      }

      isReceiving.current = true;
      try {
        await fc.loadFromJSON(JSON.parse(data));
        fc.requestRenderAll();
      } finally {
        isReceiving.current = false;
      }
    }

    // The server broadcasts "whiteboard-change" (same event name the client emits)
    socket.on("whiteboard-change", onWhiteboardChange);
    return () => { socket.off("whiteboard-change", onWhiteboardChange); };
  }, [socket]);

  // ── Sync brush color & size after state changes ────────────────────────────
  useEffect(() => {
    const b = brushRef.current;
    if (!b) return;
    b.color = color;
    b.width = brushSize;
  }, [color, brushSize]);

  // ── Sync drawing mode after tool switch ───────────────────────────────────
  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;
    fc.isDrawingMode = tool === "draw";
    fc.selection     = tool === "select";
    // Re-enable object interactivity in select mode
    fc.getObjects().forEach((obj) => {
      obj.selectable = tool === "select";
      obj.evented    = tool === "select";
    });
    fc.requestRenderAll();
  }, [tool]);

  // ── Clear ─────────────────────────────────────────────────────────────────
  function clearCanvas() {
    const fc = fabricRef.current;
    if (!fc) return;
    fc.clear();
    fc.backgroundColor = BG;
    fc.requestRenderAll();
    // Empty string signals peers to clear too
    socket.emit("whiteboard-change", { roomId, whiteboardData: "" });
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-[#18181b]">

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 bg-[#1c1c1e] border-b border-[#2d2d2d] flex-shrink-0 flex-wrap">

        {/* Tool selector */}
        <div className="flex items-center gap-1 bg-[#28282b] rounded-lg p-1">
          <ToolButton
            active={tool === "draw"}
            onClick={() => setTool("draw")}
            title="Draw"
          >
            ✏ Draw
          </ToolButton>
          <ToolButton
            active={tool === "select"}
            onClick={() => setTool("select")}
            title="Select & move objects"
          >
            ↖ Select
          </ToolButton>
        </div>

        <Divider />

        {/* Preset colours */}
        <div className="flex items-center gap-1.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              title={c}
              className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 focus:outline-none"
              style={{
                background:  c,
                borderColor: color === c ? "#fff" : "transparent",
              }}
            />
          ))}

          {/* Custom colour picker — hidden input behind a visible swatch */}
          <label title="Custom colour" className="relative cursor-pointer">
            <div
              className="w-5 h-5 rounded-full border-2 border-dashed border-gray-500 flex items-center justify-center text-gray-400 text-[9px] hover:border-gray-300 transition-colors"
              style={{ background: PRESET_COLORS.includes(color) ? "transparent" : color }}
            >
              {PRESET_COLORS.includes(color) ? "+" : ""}
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
            />
          </label>
        </div>

        <Divider />

        {/* Brush size */}
        <div className="flex items-center gap-2">
          {/* Live preview dot */}
          <div
            className="rounded-full bg-white flex-shrink-0 transition-all"
            style={{
              width:  Math.min(Math.max(brushSize, 4), 24),
              height: Math.min(Math.max(brushSize, 4), 24),
              background: color,
            }}
          />
          <input
            type="range"
            min={1}
            max={40}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-24 h-1 accent-white cursor-pointer"
          />
          <span className="text-xs text-gray-400 w-5 text-right tabular-nums">
            {brushSize}
          </span>
        </div>

        <Divider />

        {/* Clear */}
        <button
          onClick={clearCanvas}
          className="px-3 py-1.5 rounded-md text-xs font-medium text-red-400 hover:text-red-300 hover:bg-[#3f3f46] transition-colors"
        >
          Clear
        </button>

      </div>

      {/* ── Canvas area ──────────────────────────────────────────────────── */}
      <div ref={containerRef} className="flex-1 overflow-hidden">
        <canvas ref={canvasElRef} />
      </div>

    </div>
  );
}

// ─── Small local sub-components ───────────────────────────────────────────────

function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        active
          ? "bg-[#3f3f46] text-white"
          : "text-gray-400 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="h-5 w-px bg-[#3f3f46] flex-shrink-0" />;
}
