"use client";

import { useEffect, useRef, useState } from "react";
import type { Canvas as FabricCanvas, PencilBrush as FabricPencilBrush } from "fabric";
import type { DrawObject } from "@/app/api/draw/route";
import { getSocket } from "@/lib/socket";

export type { DrawObject };

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhiteboardProps {
  roomId:              string;
  initialData?:        string;
  drawCommand?:        { objects: DrawObject[]; id: number } | null;
  onWhiteboardChange?: (data: string) => void;
}

interface YjsProvider {
  awareness: {
    clientID: number;
    setLocalStateField: (field: string, value: unknown) => void;
    getStates: () => Map<number, Record<string, unknown>>;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  on: (event: string, cb: (synced: boolean) => void) => void;
  disconnect: () => void;
}

type Tool = "draw" | "select" | "rect" | "line" | "text";

// ─── Constants ────────────────────────────────────────────────────────────────

const PRESET_COLORS = [
  "#ffffff", "#f87171", "#fb923c", "#facc15",
  "#4ade80", "#38bdf8", "#818cf8", "#f472b6",
];

const CURSOR_COLORS = [
  "#f87171", "#fb923c", "#facc15", "#4ade80",
  "#38bdf8", "#818cf8", "#c084fc", "#f472b6",
];

const BG       = "#18181b";
const GRID_PX  = 30;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

let _seq = 0;
function nextId() { return `${Date.now()}-${++_seq}-${Math.random().toString(36).slice(2, 7)}`; }

// ─── Component ────────────────────────────────────────────────────────────────

export default function Whiteboard({ roomId, initialData, drawCommand, onWhiteboardChange }: WhiteboardProps) {
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
  const isDrawing    = useRef(false);

  const labelPositions = useRef<Map<string, { cx: number; cy: number }>>(new Map());
  const toolRef        = useRef<Tool>("draw");
  const colorRef       = useRef("#ffffff");
  const shapeStartRef  = useRef<{ x: number; y: number } | null>(null);
  const previewRef     = useRef<object | null>(null);
  const isShaping      = useRef(false);

  // In-progress stroke streaming (Socket.IO — ephemeral, lossy-OK)
  const currentStrokeId   = useRef("");
  const partialStrokesRef = useRef(
    new Map<string, { points: { x: number; y: number }[]; color: string; width: number }>()
  );
  // Remote cursor world-space positions — rendered in after:render, not as CSS divs,
  // so they correctly reposition when the local user pans or zooms
  const remoteCursorWorldRef = useRef(
    new Map<number, { x: number; y: number; color: string }>()
  );

  // Yjs refs
  const yobjectsRef   = useRef<import("yjs").Map<string> | null>(null);
  const ymetaRef      = useRef<import("yjs").Map<string> | null>(null);
  const ydocRef       = useRef<import("yjs").Doc | null>(null);
  const providerRef   = useRef<YjsProvider | null>(null);
  const initialDataRef = useRef(initialData);
  const onWbChangeRef  = useRef(onWhiteboardChange);

  const [tool,      setTool]      = useState<Tool>("draw");
  const [color,     setColor]     = useState("#ffffff");
  const [brushSize, setBrushSize] = useState(4);
  const [zoom,      setZoom]      = useState(100);

  // Keep refs in sync with latest prop values
  useEffect(() => { initialDataRef.current = initialData; }, [initialData]);
  useEffect(() => { onWbChangeRef.current  = onWhiteboardChange; }, [onWhiteboardChange]);
  useEffect(() => { toolRef.current  = tool;  }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);

  // ── Brush sync ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const b = brushRef.current;
    if (!b) return;
    b.color = color;
    b.width = brushSize;
  }, [color, brushSize]);

  // ── Tool mode sync ──────────────────────────────────────────────────────────
  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;
    fc.isDrawingMode = tool === "draw";
    fc.selection     = tool === "select";
    fc.defaultCursor =
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

  // ── AI draw command ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!drawCommand?.objects.length) return;
    void addDrawObjects(drawCommand.objects);
  }, [drawCommand]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Apply initialData when Yjs is ready but empty (late DB load) ────────────
  useEffect(() => {
    if (!initialData) return;
    const yobjects = yobjectsRef.current;
    if (!yobjects || yobjects.size > 0) return; // not ready or peers already have data
    const canvas = fabricRef.current;
    if (!canvas) return;
    void (async () => {
      isReceiving.current = true;
      try {
        await canvas.loadFromJSON(JSON.parse(initialData));
        canvas.requestRenderAll();
        // Push initial objects into Yjs with stable index-based IDs
        canvas.getObjects().forEach((obj, i) => {
          const id = `init-${i}`;
          (obj as { data?: { id?: string } }).data = { id };
          yobjects.set(id, JSON.stringify(
            (obj as { toJSON: (e?: string[]) => unknown }).toJSON(["data"])
          ));
        });
      } catch {
        // ignore parse errors
      } finally {
        isReceiving.current = false;
      }
    })();
  }, [initialData]);

  // ── Canvas init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasElRef.current || !containerRef.current) return;
    let cancelled = false;

    async function init() {
      await disposalRef.current;
      if (cancelled) return;

      const { Canvas, PencilBrush, Point, Rect, Line, IText, util } = await import("fabric");
      if (cancelled) return;
      FabricPoint.current = Point;

      const container = containerRef.current!;
      const w = container.clientWidth  || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;

      const fc = new Canvas(canvasElRef.current!, {
        isDrawingMode: true,
        width: w, height: h,
        selection: false,
      });
      fabricRef.current = fc;

      const brush = new PencilBrush(fc);
      brush.color = color;
      brush.width = brushSize;
      fc.freeDrawingBrush = brush;
      brushRef.current = brush;

      // Resize observer
      const ro = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        fc.width = width; fc.height = height;
        fc.calcOffset();
        fc.requestRenderAll();
      });
      ro.observe(container);

      function syncGrid() {
        const vt = fc.viewportTransform!;
        const z  = fc.getZoom();
        const gs = GRID_PX * z;
        container.style.backgroundSize     = `${gs}px ${gs}px`;
        container.style.backgroundPosition = `${vt[4] % gs}px ${vt[5] % gs}px`;
        setZoom(Math.round(z * 100));
      }

      function toCanvas(e: MouseEvent) {
        const vt = fc.viewportTransform!;
        return { x: (e.offsetX - vt[4]) / vt[0], y: (e.offsetY - vt[5]) / vt[3] };
      }

      // Zoom
      fc.on("mouse:wheel", (opt) => {
        const e = opt.e as WheelEvent;
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fc.getZoom() * (0.999 ** e.deltaY)));
        fc.zoomToPoint(new Point(e.offsetX, e.offsetY), z);
        e.preventDefault(); e.stopPropagation();
        syncGrid();
      });

      // Pan + shape start
      fc.on("mouse:down", (opt) => {
        const e = opt.e as MouseEvent;
        isDrawing.current = true;
        // Assign a stroke ID so peers can correlate streaming points → final object
        if (fc.isDrawingMode) currentStrokeId.current = nextId();
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
          isShaping.current = t !== "text";
        }
      });

      fc.on("mouse:move", (opt) => {
        const e = opt.e as MouseEvent;

        // Compute world-space pointer from clientX/Y + getBoundingClientRect.
        // This is immune to offsetX/Y edge-case bugs (pointer captured outside
        // canvas on smaller screens) and handles DPR and CSS scaling correctly.
        const rect = (fc.getElement() as HTMLCanvasElement).getBoundingClientRect();
        const scaleX = fc.width!  / rect.width;
        const scaleY = fc.height! / rect.height;
        const cx = (e.clientX - rect.left) * scaleX;
        const cy = (e.clientY - rect.top)  * scaleY;
        const vt = fc.viewportTransform!;
        const wp = { x: (cx - vt[4]) / vt[0], y: (cy - vt[5]) / vt[3] };

        // Broadcast cursor position via awareness — use world coords so
        // peers with different pan/zoom see the cursor at the right position
        const provider = providerRef.current;
        if (provider) {
          provider.awareness.setLocalStateField("cursor", {
            x: wp.x,
            y: wp.y,
            color: CURSOR_COLORS[provider.awareness.clientID % CURSOR_COLORS.length],
          });
        }

        // Stream freehand path points to peers via Socket.IO so they see
        // the stroke growing live — before the final object syncs via Yjs
        if (fc.isDrawingMode && isDrawing.current && currentStrokeId.current) {
          const sock = getSocket();
          sock?.emit("wb:point", {
            roomId,
            strokeId: currentStrokeId.current,
            x: wp.x, y: wp.y,
            color: colorRef.current,
            width: brushRef.current?.width ?? 4,
          });
        }

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
            rx: 4, ry: 4, selectable: false, evented: false,
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
        isDrawing.current     = false;
        currentStrokeId.current = "";
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
              width:  Math.abs(dx), height: Math.abs(dy),
              fill: "transparent", stroke: colorRef.current, strokeWidth: 2, rx: 4, ry: 4,
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

      // Clear our cursor from peers when the pointer leaves the canvas
      fc.on("mouse:out", () => {
        providerRef.current?.awareness.setLocalStateField("cursor", null);
      });

      // Space key pan mode
      function onKeyDown(e: KeyboardEvent) {
        if (e.code !== "Space" || e.repeat) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (!containerRef.current || containerRef.current.offsetParent === null) return;
        isSpaceDown.current = true;
        fc.defaultCursor = "grab";
        fc.setCursor("grab");
        e.preventDefault();
      }
      function onKeyUp(e: KeyboardEvent) {
        if (e.code !== "Space") return;
        isSpaceDown.current = false;
        if (!isPanning.current) { fc.defaultCursor = "crosshair"; fc.setCursor("crosshair"); }
      }
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup",   onKeyUp);
      fc.on("after:render", syncGrid);
      syncGrid();

      // Draw peers' in-progress strokes AND cursors on top of the Fabric canvas
      // every frame.  Both use world-space coordinates, so we apply the viewport
      // transform once and everything stays aligned regardless of pan/zoom.
      fc.on("after:render", ({ ctx }: { ctx: CanvasRenderingContext2D }) => {
        const strokes  = partialStrokesRef.current;
        const cursors  = remoteCursorWorldRef.current;
        if (strokes.size === 0 && cursors.size === 0) return;

        const vt = fc.viewportTransform!;
        ctx.save();
        ctx.transform(vt[0], vt[1], vt[2], vt[3], vt[4], vt[5]);

        // ── partial strokes ───────────────────────────────────────────────────
        for (const stroke of Array.from(strokes.values())) {
          if (stroke.points.length < 2) continue;
          ctx.beginPath();
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth   = stroke.width;
          ctx.lineCap     = "round";
          ctx.lineJoin    = "round";
          ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
          for (let i = 1; i < stroke.points.length; i++) {
            ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
          }
          ctx.stroke();
        }

        // ── remote cursors (world-space dots) ────────────────────────────────
        // Radius in world units so it stays ~6 px regardless of zoom
        const z = fc.getZoom();
        const r = 6 / z;
        for (const { x, y, color } of Array.from(cursors.values())) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle   = color;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth   = 1.5 / z;
          ctx.fill();
          ctx.stroke();
        }

        ctx.restore();
      });

      // ── Per-object Yjs sync ───────────────────────────────────────────────
      // Each canvas object gets a stable ID in `obj.data.id`.
      // We push individual adds/modifies/removes to a Y.Map so peers can
      // apply only the diff — no full-canvas replace, so drawings never vanish.

      function syncObjectToYjs(obj: Parameters<typeof fc.add>[0]) {
        const yobjects = yobjectsRef.current;
        if (!yobjects) return;
        const o = obj as { data?: { id?: string; strokeId?: string }; toJSON: (e?: string[]) => unknown };
        if (!o.data?.id) {
          // Tag with both a stable object ID and the stroke ID so the peer
          // knows which partial stroke to retire when the final object arrives.
          o.data = { ...(o.data ?? {}), id: nextId(), strokeId: currentStrokeId.current || undefined };
        }
        yobjects.set(o.data.id!, JSON.stringify(o.toJSON(["data"])));
        const json = JSON.stringify(fc.toJSON());
        localStorage.setItem(`room-wb-${roomId}`, json);
        onWbChangeRef.current?.(json);
      }

      fc.on("object:added", (e) => {
        if (!isReceiving.current) syncObjectToYjs(e.target as Parameters<typeof fc.add>[0]);
      });
      fc.on("object:modified", (e) => {
        if (!isReceiving.current) syncObjectToYjs(e.target as Parameters<typeof fc.add>[0]);
      });
      fc.on("object:removed", (e) => {
        if (isReceiving.current) return;
        const o = e.target as { data?: { id?: string } };
        if (o.data?.id) yobjectsRef.current?.delete(o.data.id);
        const json = JSON.stringify(fc.toJSON());
        localStorage.setItem(`room-wb-${roomId}`, json);
        onWbChangeRef.current?.(json);
      });

      // ── Yjs setup ─────────────────────────────────────────────────────────
      const [{ Doc }, { WebsocketProvider }] = await Promise.all([
        import("yjs"),
        import("y-websocket"),
      ]);
      if (cancelled) return;

      const wsUrl    = (process.env.NEXT_PUBLIC_SERVER_URL ?? "ws://localhost:3001").replace(/^http/, "ws");
      const ydoc     = new Doc();
      const yobjects = ydoc.getMap<string>("objects");
      const ymeta    = ydoc.getMap<string>("meta");
      const provider = new WebsocketProvider(`${wsUrl}/yjs`, `wb-${roomId}`, ydoc) as unknown as YjsProvider;

      ydocRef.current     = ydoc;
      yobjectsRef.current = yobjects;
      ymetaRef.current    = ymeta;
      providerRef.current = provider;

      // Receive per-object diffs from peers (no full canvas replace)
      yobjects.observe(async (event, txn) => {
        if (txn.local) return; // our own change — skip
        const canvas = fabricRef.current;
        if (!canvas) return;

        for (const [id, change] of Array.from(event.changes.keys)) {
          if (change.action === "add" || change.action === "update") {
            const serialized = yobjects.get(id);
            if (!serialized) continue;
            try {
              const parsed = JSON.parse(serialized);
              // Remove stale version of this object if present
              const old = canvas.getObjects().find(
                (o) => (o as { data?: { id?: string } }).data?.id === id
              );
              if (old) {
                isReceiving.current = true;
                canvas.remove(old);
                isReceiving.current = false;
              }
              // Enliven and add the updated object
              const enlivened = await util.enlivenObjects([parsed]) as Parameters<typeof canvas.add>[0][];
              if (enlivened[0]) {
                const obj = enlivened[0] as { data?: { id?: string; strokeId?: string } } & Parameters<typeof canvas.add>[0];
                obj.data = { id, strokeId: obj.data?.strokeId };
                isReceiving.current = true;
                canvas.add(obj);
                isReceiving.current = false;
                // Retire the ephemeral Socket.IO partial stroke now that
                // the final Yjs object has arrived
                if (obj.data?.strokeId) {
                  partialStrokesRef.current.delete(obj.data.strokeId);
                }
              }
            } catch { /* ignore bad JSON */ }
          } else if (change.action === "delete") {
            const old = canvas.getObjects().find(
              (o) => (o as { data?: { id?: string } }).data?.id === id
            );
            if (old) {
              isReceiving.current = true;
              canvas.remove(old);
              isReceiving.current = false;
            }
          }
        }
        canvas.requestRenderAll();
      });

      // Receive clear signal from peers
      ymeta.observe((_event, txn) => {
        if (txn.local) return;
        const canvas = fabricRef.current;
        if (!canvas) return;
        isReceiving.current = true;
        canvas.clear();
        canvas.requestRenderAll();
        isReceiving.current = false;
      });

      // After initial sync: seed canvas from DB/localStorage if Yjs doc is empty
      provider.on("sync", async (isSynced) => {
        if (!isSynced || yobjects.size > 0) return;
        const seed = initialDataRef.current || localStorage.getItem(`room-wb-${roomId}`);
        if (!seed) return;
        const canvas = fabricRef.current;
        if (!canvas) return;
        isReceiving.current = true;
        try {
          await canvas.loadFromJSON(JSON.parse(seed));
          canvas.requestRenderAll();
          // Push all loaded objects to Yjs with stable index-based IDs
          canvas.getObjects().forEach((obj, i) => {
            const id = `init-${i}`;
            (obj as { data?: { id?: string } }).data = { id };
            yobjects.set(id, JSON.stringify(
              (obj as { toJSON: (e?: string[]) => unknown }).toJSON(["data"])
            ));
          });
        } catch { /* ignore */ } finally {
          isReceiving.current = false;
        }
      });

      // Receive streaming path points from peers (Socket.IO — ephemeral)
      const sock = getSocket();
      function onWbPoint({ strokeId, x, y, color, width }: {
        strokeId: string; x: number; y: number; color: string; width: number;
      }) {
        const stroke = partialStrokesRef.current.get(strokeId)
          ?? { points: [], color, width };
        stroke.points.push({ x, y });
        partialStrokesRef.current.set(strokeId, stroke);
        fc.requestRenderAll(); // triggers after:render which draws the partial stroke
      }
      sock?.on("wb:point", onWbPoint);

      // Live cursors: store peers' world-space positions in a ref and redraw.
      // Using a ref (not state) avoids React re-renders on every mouse move.
      // cursor === null means the peer left the canvas — remove their dot.
      provider.awareness.on("change", () => {
        const map = remoteCursorWorldRef.current;
        map.clear();
        provider.awareness.getStates().forEach((state, clientId) => {
          if (clientId === provider.awareness.clientID) return;
          const c = state.cursor as { x: number; y: number; color: string } | null | undefined;
          if (c) map.set(clientId, { x: c.x, y: c.y, color: c.color ?? "#4ade80" });
          // null cursor → peer left canvas, already removed by map.clear() above
        });
        fc.requestRenderAll(); // triggers after:render which draws cursor dots
      });

      return () => {
        ro.disconnect();
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup",   onKeyUp);
        sock?.off("wb:point", onWbPoint);
        provider.disconnect();
        ydoc.destroy();
        ydocRef.current     = null;
        yobjectsRef.current = null;
        ymetaRef.current    = null;
        providerRef.current = null;
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

  // ── AI draw command ───────────────────────────────────────────────────────

  async function addDrawObjects(objects: DrawObject[]) {
    const fc = fabricRef.current;
    if (!fc) return;

    const { Rect, FabricText, Group, Line, Triangle } = await import("fabric");

    const BOX_W = 150;
    const BOX_H = 54;

    const boxes = objects.filter((o): o is Extract<DrawObject, { type: "box" }> => o.type === "box");
    if (boxes.length > 1) {
      const xs = boxes.map((b) => b.x);
      const spread = Math.max(...xs) - Math.min(...xs);
      if (spread < BOX_W * boxes.length * 0.8) {
        const GAP    = 60;
        const totalW = boxes.length * BOX_W + (boxes.length - 1) * GAP;
        const startX = Math.max(40, (1200 - totalW) / 2);
        const baseY  = Math.min(...boxes.map((b) => b.y)) || 300;
        boxes.forEach((b, i) => { b.x = startX + i * (BOX_W + GAP); b.y = baseY; });
      }
    }

    for (const obj of boxes) {
      const x = Math.round(obj.x ?? 200);
      const y = Math.round(obj.y ?? 300);
      const w = Math.round(obj.width  ?? BOX_W);
      const h = Math.round(obj.height ?? BOX_H);

      const rect = new Rect({
        left: -(w / 2), top: -(h / 2),
        width: w, height: h,
        fill: "#1e293b", stroke: "#475569", strokeWidth: 1.5,
        rx: 6, ry: 6, originX: "left", originY: "top",
      });
      const label = new FabricText(obj.label, {
        fontSize: 13, fill: "#e2e8f0",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontWeight: "600", originX: "center", originY: "center",
      });

      const group = new Group([rect, label], {
        left: x + w / 2, top: y + h / 2,
        originX: "center", originY: "center",
      });

      fc.add(group);
      labelPositions.current.set(obj.label, { cx: x + w / 2, cy: y + h / 2 });
    }

    for (const obj of objects) {
      if (obj.type !== "arrow") continue;
      const from = labelPositions.current.get(obj.from);
      const to   = labelPositions.current.get(obj.to);
      if (!from || !to) continue;

      const angle    = Math.atan2(to.cy - from.cy, to.cx - from.cx);
      const angleDeg = angle * (180 / Math.PI);
      const tipX     = to.cx - Math.cos(angle) * 20;
      const tipY     = to.cy - Math.sin(angle) * 20;

      fc.add(new Line([from.cx, from.cy, tipX, tipY], {
        stroke: "#64748b", strokeWidth: 1.5, selectable: true, evented: true,
      }));
      fc.add(new Triangle({
        left: to.cx - Math.cos(angle) * 12, top: to.cy - Math.sin(angle) * 12,
        width: 12, height: 14, fill: "#64748b",
        angle: angleDeg + 90, originX: "center", originY: "center",
        selectable: true, evented: true,
      }));
    }

    fc.requestRenderAll();
  }

  // ── Zoom controls ─────────────────────────────────────────────────────────

  function zoomBy(factor: number) {
    const fc    = fabricRef.current;
    const Point = FabricPoint.current;
    if (!fc || !Point) return;
    const center = new Point(fc.width / 2, fc.height / 2);
    fc.zoomToPoint(center, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fc.getZoom() * factor)));
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
    isReceiving.current = true;
    fc.clear();
    fc.requestRenderAll();
    isReceiving.current = false;

    // Clear Yjs: delete all objects + signal peers via meta
    const ydoc     = ydocRef.current;
    const yobjects = yobjectsRef.current;
    const ymeta    = ymetaRef.current;
    if (ydoc && yobjects && ymeta) {
      ydoc.transact(() => {
        Array.from(yobjects.keys()).forEach((k) => yobjects.delete(k));
        ymeta.set("clearTs", Date.now().toString());
      });
    }
    localStorage.removeItem(`room-wb-${roomId}`);
    onWbChangeRef.current?.("");
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

      {/* ── Infinite canvas + remote cursor overlay ───────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        style={{
          backgroundColor: BG,
          backgroundImage: "radial-gradient(circle, #3f3f46 1.5px, transparent 1.5px)",
          backgroundSize:  `${GRID_PX}px ${GRID_PX}px`,
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
