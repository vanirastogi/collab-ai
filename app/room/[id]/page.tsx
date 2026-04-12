"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket";
import CodeEditor from "@/components/CodeEditor";
import Whiteboard from "@/components/Whiteboard";

interface RoomState {
  code: string;
  language: string;
  whiteboardData: string;
  userCount: number;
}

type Panel = "code" | "whiteboard";

export default function RoomPage() {
  const { id: roomId } = useParams<{ id: string }>();
  const router = useRouter();

  const [code,           setCode]           = useState("");
  const [language,       setLanguage]       = useState("javascript");
  const [whiteboardData, setWhiteboardData] = useState("");
  const [userCount,      setUserCount]      = useState(1);
  const [copied,         setCopied]         = useState(false);
  const [panel,          setPanel]          = useState<Panel>("code");

  useEffect(() => {
    if (!roomId) return;
    const socket = getSocket();
    socket.emit("join-room", { roomId });

    function onRoomState(state: RoomState) {
      setCode(state.code);
      setLanguage(state.language);
      setWhiteboardData(state.whiteboardData);
      setUserCount(state.userCount);
    }
    function onUserCount(count: number) { setUserCount(count); }

    socket.on("room-state", onRoomState);
    socket.on("user-count", onUserCount);
    return () => {
      socket.off("room-state", onRoomState);
      socket.off("user-count", onUserCount);
    };
  }, [roomId]);

  async function copyRoomId() {
    await navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const socket = getSocket();

  return (
    <div className="h-screen bg-[#18181b] flex flex-col overflow-hidden">

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <header className="bg-[#1c1c1e] border-b border-[#2d2d2d] px-6 py-2.5 flex items-center justify-between flex-shrink-0">

        {/* App name */}
        <button
          onClick={() => router.push("/")}
          className="text-sm font-bold tracking-tight text-white hover:text-gray-300 transition-colors"
        >
          Collab.ai
        </button>

        {/* Panel tabs */}
        <div className="flex items-center gap-1 bg-[#28282b] rounded-lg p-1">
          <TabButton active={panel === "code"} onClick={() => setPanel("code")}>
            Code
          </TabButton>
          <TabButton active={panel === "whiteboard"} onClick={() => setPanel("whiteboard")}>
            Whiteboard
          </TabButton>
        </div>

        {/* Right: room ID + users */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-gray-400 bg-[#28282b] px-3 py-1 rounded-lg">
              {roomId}
            </span>
            <button
              onClick={copyRoomId}
              className="text-xs text-gray-400 border border-[#3f3f46] rounded-lg px-2.5 py-1 hover:text-white hover:border-gray-500 active:scale-95 transition-all"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              {userCount > 1 && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              )}
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-xs text-gray-400">
              {userCount} {userCount === 1 ? "user" : "users"}
            </span>
          </div>
        </div>

      </header>

      {/* ── Panels ───────────────────────────────────────────────────────────── */}
      {/* Both panels are always mounted so socket listeners stay active and
          Fabric / Monaco don't reinitialise on every tab switch. We toggle
          visibility with CSS rather than conditional rendering. */}
      <main className="flex-1 min-h-0 relative">

        <div className={`absolute inset-0 p-4 ${panel === "code" ? "block" : "hidden"}`}>
          <CodeEditor
            socket={socket}
            roomId={roomId}
            code={code}
            language={language}
            onCodeChange={setCode}
            issues={[]}
          />
        </div>

        <div className={`absolute inset-0 ${panel === "whiteboard" ? "block" : "hidden"}`}>
          <Whiteboard
            socket={socket}
            roomId={roomId}
            initialData={whiteboardData || undefined}
          />
        </div>

      </main>

    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
        active
          ? "bg-[#3f3f46] text-white"
          : "text-gray-400 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
