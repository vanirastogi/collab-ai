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
 * By moving the import inside a useEffect we guarantee it only executes in
 * the browser, after hydration, when the real DOM is available.
 */

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Canvas as FabricCanvas, PencilBrush as FabricPencilBrush } from "fabric";
import type { DrawObject } from "@/app/api/draw/route";

export type { DrawObject };

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhiteboardProps {
  socket:       Socket | null;
  roomId:       string;
  initialData?: string;
  /** Set by the parent each time the AI produces new objects to draw. */
  drawCommand?: { objects: DrawObject[]; id: number } | null;
}

type Tool = "draw" | "select" | "rect" | "line" | "text";

// ─── Constants ────────────────────────────────────────────────────────────────

const PRESET_COLORS = [
  "#ffffff", "#f87171", "#fb923c", "#facc15",
  "#4ade80", "#38bdf8", "#818cf8", "#f472b6",
];

const BG          = "#18181b";
const GRID_PX     = 30;   // dot spacing at zoom=1
const MIN_ZOOM    = 0.05;
const MAX_ZOOM    = 20;

// ─── Component ────────────────────────────────────────────────────────────────

export default function Whiteboard({ socket, roomId, initialData, drawCommand }: WhiteboardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasElRef  = useRef<HTMLCanvasElement>(null);
  const fabricRef    = useRef<FabricCanvas | null>(null);
  const brushRef     = useRef<FabricPencilBrush | null>(null);
  const isReceiving  = useRef(false);
  const isPanning    = useRef(false);
  const isSpaceDown  = useRef(false);
  const lastPan      = useRef({ x: 0, y: 0 });
  const disposalRef  = useRef<Promise<boolean | void>>(Promise.resolve());
  const FabricPoint  = useRef<typeof import("fabric").Point | null>(null);

  // Tracks label → center position of every AI-drawn box so arrows can connect them.
  const labelPositions = useRef<Map<string, { cx: number; cy: number }>>(new Map());

  // Shape-drawing state — used by rect/line/text tools.
  const toolRef       = useRef<Tool>("draw");
  const colorRef      = useRef("#ffffff"); // mirrors the initial color useState value
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  const previewRef    = useRef<object | null>(null);
  const isShaping     = useRef(false);

  const [tool,      setTool]      = useState<Tool>("draw");
  const [color,     setColor]     = useState("#ffffff");
  const [brushSize, setBrushSize] = useState(4);
  const [zoom,      setZoom]      = useState(100);

  // ── Canvas init ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasElRef.current || !containerRef.current) return;

    let cancelled = false;

    async function init() {
      await disposalRef.current;
      if (cancelled) return;

      const { Canvas, PencilBrush, Point, Rect, Line, IText } = await import("fabric");
      if (cancelled) return;
      FabricPoint.current = Point;

      const container = containerRef.current!;
      const w = container.clientWidth  || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;

      const fc = new Canvas(canvasElRef.current!, {
        // No backgroundColor here — the CSS dot-grid shows through instead.
        // Fabric clears to transparent each frame, revealing the grid behind.
        isDrawingMode: true,
        width:  w,
        height: h,
        selection: false,
      });

      fabricRef.current = fc;

      // ── Brush ──────────────────────────────────────────────────────────────
      const brush = new PencilBrush(fc);
      brush.color = color;
      brush.width = brushSize;
      fc.freeDrawingBrush = brush;
      brushRef.current = brush;

      // ── Resize: keep canvas filling its container ──────────────────────────
      // Fabric sets explicit px width/height on its wrapper div, preventing
      // it from stretching naturally. A ResizeObserver re-stamps the correct
      // dimensions whenever the container is resized (window resize, panel
      // toggle, etc.).
      const ro = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        // Fabric v7: width/height are direct writable properties
        fc.width  = width;
        fc.height = height;
        fc.calcOffset();
        fc.requestRenderAll();
      });
      ro.observe(container);

      // ── Pan & zoom ────────────────────────────────────────────────────────
      // Sync the CSS dot-grid position with the Fabric viewport so the grid
      // appears to scroll with the canvas content, creating an infinite feel.
      function syncGrid() {
        const vt = fc.viewportTransform!;
        const z  = fc.getZoom();
        const gs = GRID_PX * z;
        container.style.backgroundSize     = `${gs}px ${gs}px`;
        container.style.backgroundPosition = `${vt[4] % gs}px ${vt[5] % gs}px`;
        setZoom(Math.round(z * 100));
      }

      // Fabric v7: opt.e is TPointerEvent = MouseEvent | TouchEvent.
      // Cast to MouseEvent for mouse-specific properties (button, clientX/Y).
      // Convert screen coords → canvas (world) coords, accounting for pan/zoom.
      function toCanvas(e: MouseEvent) {
        const vt = fc.viewportTransform!;
        return { x: (e.offsetX - vt[4]) / vt[0], y: (e.offsetY - vt[5]) / vt[3] };
      }

      // Mouse-wheel zoom — zooms toward the cursor position
      fc.on("mouse:wheel", (opt) => {
        const e = opt.e as WheelEvent;
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM,
          fc.getZoom() * (0.999 ** e.deltaY)
        ));
        fc.zoomToPoint(new Point(e.offsetX, e.offsetY), z);
        e.preventDefault();
        e.stopPropagation();
        syncGrid();
      });

      // Middle-mouse or Space+drag → pan; left-click → shape tool
      fc.on("mouse:down", (opt) => {
        const e = opt.e as MouseEvent;
        const isMiddle    = e.button === 1;
        const isSpaceDrag = isSpaceDown.current && e.button === 0;
        if (isMiddle || isSpaceDrag) {
          isPanning.current = true;
          lastPan.current = { x: e.clientX, y: e.clientY };
          fc.setCursor("grabbing");
          e.preventDefault();
          return;
        }
        if (e.button !== 0) return;
        const t = toolRef.current;
        if (t === "rect" || t === "line" || t === "text") {
          shapeStartRef.current = toCanvas(e);
          isShaping.current     = t !== "text"; // text fires on mouseup, no drag
        }
      });

      fc.on("mouse:move", (opt) => {
        const e = opt.e as MouseEvent;
        if (isPanning.current) {
          fc.relativePan(new Point(e.clientX - lastPan.current.x, e.clientY - lastPan.current.y));
          lastPan.current = { x: e.clientX, y: e.clientY };
          syncGrid();
          return;
        }
        if (!isShaping.current || !shapeStartRef.current) return;

        const curr  = toCanvas(e);
        const start = shapeStartRef.current;
        const t     = toolRef.current;

        // Remove old preview without triggering a socket emit
        if (previewRef.current) {
          isReceiving.current = true;
          fc.remove(previewRef.current as Parameters<typeof fc.remove>[0]);
          isReceiving.current = false;
          previewRef.current  = null;
        }

        let preview: ReturnType<typeof fc.getObjects>[0] | null = null;
        if (t === "rect") {
          preview = new Rect({
            left:   Math.min(start.x, curr.x),
            top:    Math.min(start.y, curr.y),
            width:  Math.abs(curr.x - start.x),
            height: Math.abs(curr.y - start.y),
            fill: "transparent", stroke: colorRef.current, strokeWidth: 2,
            rx: 4, ry: 4,
            selectable: false, evented: false,
          });
        } else if (t === "line") {
          preview = new Line([start.x, start.y, curr.x, curr.y], {
            stroke: colorRef.current, strokeWidth: 2,
            selectable: false, evented: false,
          });
        }
        if (preview) {
          isReceiving.current = true;
          fc.add(preview);
          isReceiving.current = false;
          previewRef.current  = preview;
          fc.requestRenderAll();
        }
      });

      fc.on("mouse:up", (opt) => {
        if (isPanning.current) {
          isPanning.current = false;
          fc.setCursor(isSpaceDown.current ? "grab" : "crosshair");
          return;
        }

        const start = shapeStartRef.current;
        if (!start) return;

        const e    = opt.e as MouseEvent;
        const curr = toCanvas(e);
        const t    = toolRef.current;

        // Remove preview silently
        if (previewRef.current) {
          isReceiving.current = true;
          fc.remove(previewRef.current as Parameters<typeof fc.remove>[0]);
          isReceiving.current = false;
          previewRef.current  = null;
        }

        const dx = curr.x - start.x;
        const dy = curr.y - start.y;

        if (t === "text") {
          const txt = new IText("Text", {
            left: start.x, top: start.y,
            fontSize: 18, fill: colorRef.current,
            fontFamily: "system-ui, -apple-system, sans-serif",
          });
          fc.add(txt);
          fc.setActiveObject(txt);
          txt.enterEditing();
          txt.selectAll();
        } else if (Math.hypot(dx, dy) > 5) {
          if (t === "rect") {
            fc.add(new Rect({
              left:   Math.min(start.x, curr.x),
              top:    Math.min(start.y, curr.y),
              width:  Math.abs(dx),
              height: Math.abs(dy),
              fill: "transparent", stroke: colorRef.current, strokeWidth: 2,
              rx: 4, ry: 4,
            }));
          } else if (t === "line") {
            fc.add(new Line([start.x, start.y, curr.x, curr.y], {
              stroke: colorRef.current, strokeWidth: 2,
            }));
          }
        }

        fc.requestRenderAll();
        isShaping.current     = false;
        shapeStartRef.current = null;
      });

      // Space key: temporary pan mode
      function onKeyDown(e: KeyboardEvent) {
        if (e.code !== "Space" || e.repeat) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        // Do not intercept if Whiteboard is hidden (Code/DSA tab is active)
        if (!containerRef.current || containerRef.current.offsetParent === null) return;
        
        isSpaceDown.current = true;
        fc.defaultCursor = "grab";
        fc.setCursor("grab");
        e.preventDefault();
      }
      function onKeyUp(e: KeyboardEvent) {
        if (e.code !== "Space") return;
        isSpaceDown.current = false;
        if (!isPanning.current) {
          fc.defaultCursor = "crosshair";
          fc.setCursor("crosshair");
        }
      }
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup",   onKeyUp);

      // ── After:render — keep grid in sync ─────────────────────────────────
      fc.on("after:render", syncGrid);
      syncGrid();

      // ── Late-joiner: load existing room state ─────────────────────────────
      if (initialData) {
        isReceiving.current = true;
        try {
          await fc.loadFromJSON(JSON.parse(initialData));
          fc.requestRenderAll();
        } finally {
          isReceiving.current = false;
        }
      }

      // ── Emit local changes ────────────────────────────────────────────────
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

      // Cleanup
      return () => {
        ro.disconnect();
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup",   onKeyUp);
      };
    }

    let innerCleanup: (() => void) | undefined;
    init().then((cleanup) => { innerCleanup = cleanup; });

    return () => {
      cancelled = true;
      innerCleanup?.();
      if (fabricRef.current) {
        disposalRef.current = fabricRef.current.dispose();
        fabricRef.current = null;
        brushRef.current  = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Incoming whiteboard updates ────────────────────────────────────────────
  useEffect(() => {
    async function onWhiteboardChange(data: string) {
      const fc = fabricRef.current;
      if (!fc) return;

      if (!data) {
        fc.clear();
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

    socket.on("whiteboard-change", onWhiteboardChange);
    return () => { socket.off("whiteboard-change", onWhiteboardChange); };
  }, [socket]);

  // ── Sync refs used inside init's closure ─────────────────────────────────
  useEffect(() => { toolRef.current  = tool;  }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);

  // ── Sync brush ────────────────────────────────────────────────────────────
  useEffect(() => {
    const b = brushRef.current;
    if (!b) return;
    b.color = color;
    b.width = brushSize;
  }, [color, brushSize]);

  // ── Sync tool mode ────────────────────────────────────────────────────────
  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;
    fc.isDrawingMode  = tool === "draw";
    fc.selection      = tool === "select";
    fc.defaultCursor  =
      tool === "text"   ? "text"
      : tool === "rect" || tool === "line" ? "crosshair"
      : tool === "draw" ? "crosshair"
      : "default";
    fc.getObjects().forEach((o) => {
      o.selectable = tool === "select";
      o.evented    = tool === "select";
    });
    fc.requestRenderAll();
  }, [tool]);

  // ── AI draw command ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!drawCommand?.objects.length) return;
    void addDrawObjects(drawCommand.objects);
  }, [drawCommand]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addDrawObjects(objects: DrawObject[]) {
    const fc = fabricRef.current;
    if (!fc) return;

    const { Rect, FabricText, Group, Line, Triangle } = await import("fabric");

    const BOX_W = 150;
    const BOX_H = 54;

    // Auto-layout: if multiple boxes arrive together and their positions look
    // clustered, spread them in a row with even spacing.
    const boxes = objects.filter((o): o is Extract<DrawObject, { type: "box" }> => o.type === "box");
    if (boxes.length > 1) {
      const xs = boxes.map((b) => b.x);
      const spread = Math.max(...xs) - Math.min(...xs);
      if (spread < BOX_W * boxes.length * 0.8) {
        // Re-space them evenly across the canvas
        const GAP      = 60;
        const totalW   = boxes.length * BOX_W + (boxes.length - 1) * GAP;
        const startX   = Math.max(40, (1200 - totalW) / 2);
        const baseY    = Math.min(...boxes.map((b) => b.y)) || 300;
        boxes.forEach((b, i) => {
          b.x = startX + i * (BOX_W + GAP);
          b.y = baseY;
        });
      }
    }

    // Pass 1 — add boxes as a Group (rect + label move together).
    for (const obj of boxes) {
      const x = Math.round(obj.x ?? 200);
      const y = Math.round(obj.y ?? 300);
      const w = Math.round(obj.width  ?? BOX_W);
      const h = Math.round(obj.height ?? BOX_H);

      // Objects inside a Group are positioned relative to the group's center.
      const rect = new Rect({
        left: -(w / 2), top: -(h / 2),
        width: w, height: h,
        fill: "#1e293b", stroke: "#475569", strokeWidth: 1.5,
        rx: 6, ry: 6,
        originX: "left", originY: "top",
      });
      const label = new FabricText(obj.label, {
        fontSize: 13, fill: "#e2e8f0",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontWeight: "600",
        originX: "center", originY: "center",
      });

      const group = new Group([rect, label], {
        left: x + w / 2,
        top:  y + h / 2,
        originX: "center",
        originY: "center",
      });

      fc.add(group);
      labelPositions.current.set(obj.label, { cx: x + w / 2, cy: y + h / 2 });
    }

    // Pass 2 — add arrows between labeled boxes.
    for (const obj of objects) {
      if (obj.type !== "arrow") continue;
      const from = labelPositions.current.get(obj.from);
      const to   = labelPositions.current.get(obj.to);
      if (!from || !to) continue;

      const angle    = Math.atan2(to.cy - from.cy, to.cx - from.cx);
      const angleDeg = angle * (180 / Math.PI);
      const tipX     = to.cx - Math.cos(angle) * 20;
      const tipY     = to.cy - Math.sin(angle) * 20;

      const line = new Line([from.cx, from.cy, tipX, tipY], {
        stroke: "#64748b", strokeWidth: 1.5,
        selectable: true, evented: true,
      });
      const head = new Triangle({
        left: to.cx - Math.cos(angle) * 12,
        top:  to.cy - Math.sin(angle) * 12,
        width: 12, height: 14, fill: "#64748b",
        angle: angleDeg + 90,
        originX: "center", originY: "center",
        selectable: true, evented: true,
      });

      fc.add(line);
      fc.add(head);
    }

    fc.requestRenderAll();
  }

  // ── Zoom controls ─────────────────────────────────────────────────────────
  function zoomBy(factor: number) {
    const fc = fabricRef.current;
    const Point = FabricPoint.current;
    if (!fc || !Point) return;
    const center = new Point(fc.width / 2, fc.height / 2);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fc.getZoom() * factor));
    fc.zoomToPoint(center, z);
    fc.requestRenderAll();
  }

  function resetView() {
    const fc = fabricRef.current;
    if (!fc) return;
    fc.setViewportTransform([1, 0, 0, 1, 0, 0]);
    fc.requestRenderAll();
  }

  // ── Clear ─────────────────────────────────────────────────────────────────
  function clearCanvas() {
    const fc = fabricRef.current;
    if (!fc) return;
    fc.clear();
    fc.requestRenderAll();
    socket.emit("whiteboard-change", { roomId, whiteboardData: "" });
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 bg-[#1c1c1e] border-b border-[#2d2d2d] flex-shrink-0 flex-wrap">

        <div className="flex items-center gap-1 bg-[#28282b] rounded-lg p-1">
          <ToolButton active={tool === "draw"}   onClick={() => setTool("draw")}   title="Freehand draw">✏ Draw</ToolButton>
          <ToolButton active={tool === "rect"}   onClick={() => setTool("rect")}   title="Rectangle">⬜ Rect</ToolButton>
          <ToolButton active={tool === "line"}   onClick={() => setTool("line")}   title="Line / Arrow">╱ Line</ToolButton>
          <ToolButton active={tool === "text"}   onClick={() => setTool("text")}   title="Text label">T Text</ToolButton>
          <ToolButton active={tool === "select"} onClick={() => setTool("select")} title="Select & move">↖ Select</ToolButton>
        </div>

        <Divider />

        {/* Colours */}
        <div className="flex items-center gap-1.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              title={c}
              className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 focus:outline-none"
              style={{ background: c, borderColor: color === c ? "#fff" : "transparent" }}
            />
          ))}
          <label title="Custom colour" className="relative cursor-pointer">
            <div
              className="w-5 h-5 rounded-full border-2 border-dashed border-gray-500 flex items-center justify-center text-gray-400 text-[9px] hover:border-gray-300 transition-colors"
              style={{ background: PRESET_COLORS.includes(color) ? "transparent" : color }}
            >
              {PRESET_COLORS.includes(color) ? "+" : ""}
            </div>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
              className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" />
          </label>
        </div>

        <Divider />

        {/* Brush size */}
        <div className="flex items-center gap-2">
          <div className="rounded-full flex-shrink-0 transition-all"
            style={{ width: Math.min(Math.max(brushSize, 4), 24), height: Math.min(Math.max(brushSize, 4), 24), background: color }} />
          <input type="range" min={1} max={40} value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-24 h-1 accent-white cursor-pointer" />
          <span className="text-xs text-gray-400 w-5 text-right tabular-nums">{brushSize}</span>
        </div>

        <Divider />

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <IconButton onClick={() => zoomBy(1 / 1.25)} title="Zoom out">−</IconButton>
          <span className="text-xs text-gray-400 tabular-nums w-10 text-center">{zoom}%</span>
          <IconButton onClick={() => zoomBy(1.25)} title="Zoom in">+</IconButton>
          <IconButton onClick={resetView} title="Reset view (100%, centered)">⊡</IconButton>
        </div>

        <Divider />

        <button onClick={clearCanvas}
          className="px-3 py-1.5 rounded-md text-xs font-medium text-red-400 hover:text-red-300 hover:bg-[#3f3f46] transition-colors">
          Clear
        </button>

      </div>

      {/* ── Infinite canvas ───────────────────────────────────────────────── */}
      {/* The dot-grid is a CSS background on this div. Fabric's canvas has    */}
      {/* no backgroundColor, so it's transparent — the dots show through.    */}
      {/* syncGrid() updates background-size and background-position on every  */}
      {/* render to keep the grid locked to world-space as you pan and zoom.   */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{
          backgroundColor:   BG,
          backgroundImage:   "radial-gradient(circle, #3f3f46 1.5px, transparent 1.5px)",
          backgroundSize:    `${GRID_PX}px ${GRID_PX}px`,
        }}
      >
        <canvas ref={canvasElRef} />
      </div>

      {/* ── Hint bar ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-4 py-1 bg-[#1c1c1e] border-t border-[#2d2d2d] flex gap-4">
        <Hint>Scroll to zoom</Hint>
        <Hint>Middle-mouse or Space+drag to pan</Hint>
      </div>

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolButton({ active, onClick, title, children }: {
  active: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title}
      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        active ? "bg-[#3f3f46] text-white" : "text-gray-400 hover:text-white"}`}>
      {children}
    </button>
  );
}

function IconButton({ onClick, title, children }: {
  onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title}
      className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-[#3f3f46] text-sm transition-colors">
      {children}
    </button>
  );
}

function Divider() {
  return <div className="h-5 w-px bg-[#3f3f46] flex-shrink-0" />;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] text-gray-600">{children}</span>;
}
