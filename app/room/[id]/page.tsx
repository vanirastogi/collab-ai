"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useUser, UserButton } from "@clerk/nextjs";
import { getSocket } from "@/lib/socket";
import CodeEditor, { type Issue } from "@/components/CodeEditor";
import Whiteboard, { type DrawObject } from "@/components/Whiteboard";
import AIPanel from "@/components/AIPanel";
import DSALadder from "@/components/DSALadder";
import type { RunResult } from "@/app/api/run/route";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RoomState {
  code: string;
  language: string;
  whiteboardData: string;
  userCount: number;
}

type Tab = "code" | "whiteboard" | "dsa";
type SaveStatus = "saved" | "saving" | "unsaved";

const LANGUAGES = [
  "javascript", "typescript", "python", "java",
  "c",          "cpp",        "csharp", "go",
  "rust",       "ruby",       "php",    "swift",
  "kotlin",     "html",       "css",    "json",
  "markdown",   "sql",        "bash",
];

const RUNNABLE = new Set([
  "javascript", "typescript", "python", "java", "c", "cpp",
  "csharp", "go", "rust", "ruby", "php", "swift", "kotlin", "bash",
]);

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RoomPage() {
  const { id: roomId } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useUser();
  const socket = getSocket();

  const userName =
    user?.fullName ?? user?.firstName ?? user?.username ?? "Anonymous";

  const [tab,            setTab]            = useState<Tab>("code");
  const [code,           setCode]           = useState("");
  const [language,       setLanguage]       = useState("javascript");
  const [whiteboardData, setWhiteboardData] = useState("");
  const [userCount,      setUserCount]      = useState(1);
  const [copied,         setCopied]         = useState(false);
  const [issues,         setIssues]         = useState<Issue[]>([]);
  const [drawCommand,    setDrawCommand]    = useState<{ objects: DrawObject[]; id: number } | null>(null);
  const [runResult,      setRunResult]      = useState<RunResult | null>(null);
  const [running,        setRunning]        = useState(false);
  const [saveStatus,     setSaveStatus]     = useState<SaveStatus>("saved");
  const [dbLoaded,       setDbLoaded]       = useState(false);

  // Timer refs — never cause re-renders
  const autoReviewTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeSaveTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wbSaveTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCode        = useRef(code);
  const latestLanguage    = useRef(language);
  const latestWb          = useRef(whiteboardData);
  const [reviewTrigger,  setReviewTrigger]  = useState(0);
  // True once the socket gives us real live state — DB load should not override it
  const socketGaveData    = useRef(false);

  // ── DB load on mount ────────────────────────────────────────────────────────
  // Fetch persisted room state from Supabase. If the room doesn't exist yet
  // (user navigated directly via URL), create it so it's tracked.
  useEffect(() => {
    if (!roomId || !user) return;

    async function loadOrCreate() {
      const res = await fetch(`/api/rooms/${roomId}`);

      if (res.ok) {
        const data = await res.json();
        // Only apply DB state if the socket didn't already give us live data.
        // If other users are in the room, their in-memory socket state is more
        // current than the DB (which lags by the 2 s debounce). If the socket
        // came back empty (server restart, no active users), DB is the source
        // of truth.
        if (!socketGaveData.current) {
          if (data.code)      setCode(data.code);
          if (data.language)  setLanguage(data.language);
          if (data.whiteboard && JSON.stringify(data.whiteboard) !== "{}") {
            setWhiteboardData(JSON.stringify(data.whiteboard));
          }
        }
      } else if (res.status === 404) {
        // Room exists in Socket.IO memory but not in DB yet — create it.
        await fetch("/api/rooms", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ name: `Room ${roomId}`, language, userName }),
        });
      }
      setDbLoaded(true);
    }

    loadOrCreate();
  }, [roomId, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Persist helper ──────────────────────────────────────────────────────────
  const saveToDb = useCallback(
    async (patch: Record<string, unknown>) => {
      setSaveStatus("saving");
      try {
        await fetch(`/api/rooms/${roomId}`, {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ ...patch, userName }),
        });
        setSaveStatus("saved");
      } catch {
        setSaveStatus("unsaved");
      }
    },
    [roomId, userName],
  );

  // ── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId) return;
    socket.emit("join-room", { roomId, userId: user?.id, userName });

    function onRoomState(state: RoomState) {
      // Mark that socket gave us real live data so the DB load won't clobber it.
      // Live data = other users are present, or the server has code/whiteboard in memory.
      if (state.userCount > 1 || state.code || state.whiteboardData) {
        socketGaveData.current = true;
      }
      setCode(state.code);
      setLanguage(state.language);
      setWhiteboardData(state.whiteboardData);
      setUserCount(state.userCount);
    }
    function onUserCount(count: number) { setUserCount(count); }
    function onLanguageChange(lang: string) { setLanguage(lang); }

    socket.on("room-state",      onRoomState);
    socket.on("user-count",      onUserCount);
    socket.on("language-change", onLanguageChange);
    return () => {
      socket.off("room-state",      onRoomState);
      socket.off("user-count",      onUserCount);
      socket.off("language-change", onLanguageChange);
    };
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keep latest-value refs in sync (for debounced save closures) ───────────
  useEffect(() => { latestCode.current     = code;          }, [code]);
  useEffect(() => { latestLanguage.current = language;      }, [language]);
  useEffect(() => { latestWb.current       = whiteboardData;}, [whiteboardData]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  async function copyRoomId() {
    await navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleLanguageChange(lang: string) {
    setLanguage(lang);
    socket.emit("language-change", { roomId, language: lang });
    // Persist language change immediately (it's a rare, intentional action)
    saveToDb({ language: lang });
  }

  function handleDrawObjects(objects: DrawObject[]) {
    setDrawCommand({ objects, id: Date.now() });
  }

  async function handleRun() {
    if (running || !code.trim()) return;
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch("/api/run", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code, language }),
      });
      const data = await res.json();
      if (data.error) {
        setRunResult({ stdout: "", stderr: data.error, exitCode: -1, language });
      } else {
        setRunResult(data as RunResult);
      }
    } catch {
      setRunResult({ stdout: "", stderr: "Network error — could not reach run API.", exitCode: -1, language });
    } finally {
      setRunning(false);
    }
  }

  // ── Debounced code-change handler ────────────────────────────────────────────
  // Two separate debounces share this handler:
  //   • AI review fires after 3 s of no typing
  //   • DB save fires after 2 s of no typing (faster = less data loss on refresh)
  function handleCodeChange(newCode: string) {
    setCode(newCode);
    setSaveStatus("unsaved");

    // AI review debounce (3 s)
    if (autoReviewTimer.current) clearTimeout(autoReviewTimer.current);
    autoReviewTimer.current = setTimeout(() => {
      autoReviewTimer.current = null;
      setReviewTrigger((n) => n + 1);
    }, 3000);

    // DB save debounce (2 s)
    if (codeSaveTimer.current) clearTimeout(codeSaveTimer.current);
    codeSaveTimer.current = setTimeout(() => {
      codeSaveTimer.current = null;
      saveToDb({ code: latestCode.current, language: latestLanguage.current });
    }, 2000);
  }

  // ── Debounced whiteboard-change handler ──────────────────────────────────────
  // Called when Whiteboard emits a change via the socket listener in the parent.
  // We intercept whiteboardData updates and schedule a DB save.
  // The whiteboard socket already syncs peers — this only persists to DB.
  useEffect(() => {
    if (!dbLoaded || !whiteboardData) return;
    setSaveStatus("unsaved");

    if (wbSaveTimer.current) clearTimeout(wbSaveTimer.current);
    wbSaveTimer.current = setTimeout(() => {
      wbSaveTimer.current = null;
      try {
        const parsed = JSON.parse(latestWb.current);
        saveToDb({ whiteboard: parsed });
      } catch {
        // Not valid JSON yet — skip
      }
    }, 3000);
  }, [whiteboardData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-[#18181b] flex flex-col overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 bg-[#1c1c1e] border-b border-[#2d2d2d] px-4 h-12 flex items-center gap-3">

        {/* App name */}
        <button
          onClick={() => router.push("/")}
          className="text-sm font-bold tracking-tight text-white hover:text-gray-300 transition-colors mr-1"
        >
          Collab.ai
        </button>

        <HeaderDivider />

        {/* Tab switcher */}
        <div className="flex items-center gap-1 bg-[#28282b] rounded-lg p-0.5">
          <TabButton active={tab === "code"}       onClick={() => setTab("code")}>Code</TabButton>
          <TabButton active={tab === "whiteboard"} onClick={() => setTab("whiteboard")}>Whiteboard</TabButton>
          <TabButton active={tab === "dsa"}        onClick={() => setTab("dsa")}>DSA Ladder</TabButton>
        </div>

        {/* Language selector */}
        <select
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value)}
          className="bg-[#28282b] text-gray-300 text-xs rounded-lg px-2 py-1.5 border border-[#3f3f46] focus:outline-none focus:border-gray-500 cursor-pointer transition-colors hover:border-gray-500"
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>

        {/* Run button */}
        {tab === "code" && RUNNABLE.has(language) && (
          <button
            onClick={handleRun}
            disabled={running || !code.trim()}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors active:scale-95"
          >
            {running ? (
              <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <span>▶</span>
            )}
            {running ? "Running…" : "Run"}
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Save indicator */}
        <SaveIndicator status={saveStatus} />

        <HeaderDivider />

        {/* Room ID + copy */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-gray-500 bg-[#28282b] px-2.5 py-1 rounded-lg hidden sm:block">
            {roomId}
          </span>
          <button
            onClick={copyRoomId}
            className="text-xs text-gray-400 border border-[#3f3f46] rounded-lg px-2.5 py-1 hover:text-white hover:border-gray-500 active:scale-95 transition-all"
          >
            {copied ? "Copied!" : "Copy ID"}
          </button>
        </div>

        <HeaderDivider />

        {/* Online count */}
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            {userCount > 1 && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            )}
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-xs text-gray-400 tabular-nums">
            {userCount} {userCount === 1 ? "user" : "users"}
          </span>
        </div>

        <HeaderDivider />

        {/* User avatar */}
        <UserButton />

      </header>

      {/* ── Main ─────────────────────────────────────────────────────────────── */}
      <main className="flex-1 min-h-0 flex flex-row">

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-hidden relative">

          <div className={`absolute inset-0 flex flex-col ${tab === "code" ? "" : "hidden"}`}>

            <div className="flex-1 min-h-0 p-3 flex">
              <CodeEditor
                socket={socket}
                roomId={roomId}
                code={code}
                language={language}
                onCodeChange={handleCodeChange}
                issues={issues}
              />
            </div>

            {/* Output panel */}
            {runResult && (
              <div className="flex-shrink-0 h-48 border-t border-[#2d2d2d] flex flex-col bg-[#0d0d0f]">
                <div className="flex items-center gap-3 px-3 py-1.5 bg-[#1c1c1e] border-b border-[#2d2d2d] flex-shrink-0">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Output</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                    runResult.exitCode === 0
                      ? "bg-green-500/15 text-green-400"
                      : "bg-red-500/15 text-red-400"
                  }`}>
                    exit {runResult.exitCode}
                  </span>
                  <div className="flex-1" />
                  <button
                    onClick={() => setRunResult(null)}
                    className="text-gray-600 hover:text-gray-300 text-sm leading-none transition-colors"
                    title="Close output"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
                  {runResult.stdout && (
                    <pre className="text-gray-300 whitespace-pre-wrap break-words">{runResult.stdout}</pre>
                  )}
                  {runResult.stderr && (
                    <pre className="text-red-400 whitespace-pre-wrap break-words">{runResult.stderr}</pre>
                  )}
                  {!runResult.stdout && !runResult.stderr && (
                    <span className="text-gray-600">No output.</span>
                  )}
                </div>
              </div>
            )}

          </div>

          <div className={`absolute inset-0 ${tab === "whiteboard" ? "flex" : "hidden"}`}>
            <Whiteboard
              socket={socket}
              roomId={roomId}
              initialData={whiteboardData || undefined}
              drawCommand={drawCommand}
            />
          </div>

          <div className={`absolute inset-0 ${tab === "dsa" ? "flex" : "hidden"}`}>
            <DSALadder
              socket={socket}
              roomId={roomId}
              userId={user?.id || ""}
              userName={userName}
            />
          </div>

        </div>

        {/* ── AI panel ─────────────────────────────────────────────────────── */}
        <aside className="w-80 flex-shrink-0 bg-[#1c1c1e] border-l border-[#2d2d2d] flex flex-col min-h-0">
          <AIPanel
            code={code}
            language={language}
            onIssuesFound={setIssues}
            onDrawObjects={handleDrawObjects}
            whiteboardData={whiteboardData}
            autoTrigger={reviewTrigger}
          />
        </aside>

      </main>

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === "saved") {
    return (
      <span className="text-[11px] text-gray-600 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-green-600 inline-block" />
        Saved
      </span>
    );
  }
  if (status === "saving") {
    return (
      <span className="text-[11px] text-gray-500 flex items-center gap-1.5">
        <span className="inline-block w-3 h-3 border border-gray-500 border-t-transparent rounded-full animate-spin" />
        Saving…
      </span>
    );
  }
  // unsaved
  return (
    <span className="text-[11px] text-gray-600 flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
      Unsaved
    </span>
  );
}

function TabButton({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
        active ? "bg-[#3f3f46] text-white" : "text-gray-400 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function HeaderDivider() {
  return <div className="h-4 w-px bg-[#3f3f46] flex-shrink-0" />;
}
