"use client";

import { useEffect, useState, useRef, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { SignInButton, SignUpButton, UserButton, useUser } from "@clerk/nextjs";
import { formatDistanceToNow } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Room {
  id:           string;
  name:         string;
  language:     string;
  last_active:  string;
  member_count: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LANGUAGES = [
  "javascript", "typescript", "python", "java",
  "c", "cpp", "csharp", "go", "rust", "ruby",
  "php", "swift", "kotlin", "bash",
];

// Per-language color badge
const LANG_COLOR: Record<string, string> = {
  javascript: "bg-yellow-400/15 text-yellow-300 border-yellow-400/30",
  typescript: "bg-blue-400/15 text-blue-300 border-blue-400/30",
  python:     "bg-green-400/15 text-green-300 border-green-400/30",
  java:       "bg-orange-400/15 text-orange-300 border-orange-400/30",
  c:          "bg-gray-400/15 text-gray-300 border-gray-400/30",
  cpp:        "bg-purple-400/15 text-purple-300 border-purple-400/30",
  csharp:     "bg-violet-400/15 text-violet-300 border-violet-400/30",
  go:         "bg-cyan-400/15 text-cyan-300 border-cyan-400/30",
  rust:       "bg-orange-600/15 text-orange-400 border-orange-600/30",
  ruby:       "bg-red-400/15 text-red-300 border-red-400/30",
  php:        "bg-indigo-400/15 text-indigo-300 border-indigo-400/30",
  swift:      "bg-orange-400/15 text-orange-300 border-orange-400/30",
  kotlin:     "bg-purple-500/15 text-purple-300 border-purple-500/30",
  bash:       "bg-emerald-400/15 text-emerald-300 border-emerald-400/30",
};

function langBadge(lang: string) {
  return LANG_COLOR[lang] ?? "bg-gray-400/15 text-gray-300 border-gray-400/30";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  const router = useRouter();
  const { isSignedIn, user, isLoaded } = useUser();

  const [rooms,       setRooms]       = useState<Room[]>([]);
  const [roomsLoading,setRoomsLoading]= useState(false);
  const [joinInput,   setJoinInput]   = useState("");

  // Create-room modal
  const [modalOpen,   setModalOpen]   = useState(false);
  const [newName,     setNewName]     = useState("");
  const [newLang,     setNewLang]     = useState("javascript");
  const [creating,    setCreating]    = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  // Fetch rooms whenever the user signs in
  useEffect(() => {
    if (!isSignedIn) { setRooms([]); return; }
    setRoomsLoading(true);
    fetch("/api/rooms")
      .then((r) => r.json())
      .then((data: Room[]) => setRooms(Array.isArray(data) ? data : []))
      .catch(() => setRooms([]))
      .finally(() => setRoomsLoading(false));
  }, [isSignedIn]);

  // Focus the name input when modal opens
  useEffect(() => {
    if (modalOpen) setTimeout(() => nameInputRef.current?.focus(), 50);
  }, [modalOpen]);

  async function createRoom() {
    if (creating) return;
    setCreating(true);
    try {
      const userName = user?.fullName ?? user?.firstName ?? user?.username ?? "Anonymous";
      const res = await fetch("/api/rooms", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:     newName.trim() || "Untitled Room",
          language: newLang,
          userName,
        }),
      });
      const data = await res.json();
      if (data.id) router.push(`/room/${data.id}`);
    } finally {
      setCreating(false);
    }
  }

  function joinRoom() {
    const id = joinInput.trim();
    if (id) router.push(`/room/${id}`);
  }

  function handleJoinKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") joinRoom();
  }

  function handleModalKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) createRoom();
    if (e.key === "Escape") setModalOpen(false);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#18181b] text-white">

      {/* ── Top nav ──────────────────────────────────────────────────────── */}
      <nav className="border-b border-[#2d2d2d] bg-[#1c1c1e] px-6 h-14 flex items-center justify-between">
        <span className="text-base font-bold tracking-tight">Collab.ai</span>

        <div className="flex items-center gap-3">
          {!isLoaded ? (
            <div className="h-8 w-24 rounded-lg bg-[#28282b] animate-pulse" />
          ) : isSignedIn ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-400 hidden sm:block">
                {user.firstName ?? user.username}
              </span>
              <UserButton />
            </div>
          ) : (
            <div className="flex gap-2">
              <SignInButton mode="redirect">
                <button className="px-4 py-1.5 rounded-lg border border-[#3f3f46] text-sm text-gray-300 hover:text-white hover:border-gray-500 transition-colors">
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="redirect">
                <button className="px-4 py-1.5 rounded-lg bg-white text-black text-sm font-medium hover:bg-gray-200 transition-colors">
                  Sign up
                </button>
              </SignUpButton>
            </div>
          )}
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col gap-10">

        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        {!isSignedIn && isLoaded && (
          <div className="text-center py-16 flex flex-col items-center gap-6">
            <h1 className="text-4xl font-bold tracking-tight">
              Code together, in real time.
            </h1>
            <p className="text-gray-400 text-lg max-w-md">
              Collaborative editor, live whiteboard, and AI code review — all in one room.
            </p>
            <div className="flex gap-3">
              <SignInButton mode="redirect">
                <button className="px-6 py-2.5 rounded-xl border border-[#3f3f46] text-sm font-medium text-gray-300 hover:text-white hover:border-gray-500 transition-colors">
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="redirect">
                <button className="px-6 py-2.5 rounded-xl bg-white text-black text-sm font-medium hover:bg-gray-200 transition-colors">
                  Get started free
                </button>
              </SignUpButton>
            </div>
          </div>
        )}

        {/* ── Room dashboard ───────────────────────────────────────────────── */}
        {isSignedIn && (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Your rooms</h2>
              <button
                onClick={() => { setNewName(""); setNewLang("javascript"); setModalOpen(true); }}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                <span className="text-lg leading-none">+</span>
                New room
              </button>
            </div>

            {/* Room grid */}
            {roomsLoading ? (
              // Skeleton loaders
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="rounded-xl border border-[#2d2d2d] bg-[#1c1c1e] p-5 flex flex-col gap-3 animate-pulse">
                    <div className="h-4 w-32 rounded bg-[#28282b]" />
                    <div className="h-3 w-20 rounded bg-[#28282b]" />
                    <div className="h-8 w-full rounded-lg bg-[#28282b] mt-2" />
                  </div>
                ))}
              </div>
            ) : rooms.length === 0 ? (
              // Empty state
              <div className="flex flex-col items-center justify-center py-20 gap-4 border border-dashed border-[#3f3f46] rounded-xl text-center">
                <span className="text-4xl">🗂</span>
                <p className="text-gray-400">No rooms yet — create your first one.</p>
                <button
                  onClick={() => { setNewName(""); setNewLang("javascript"); setModalOpen(true); }}
                  className="px-5 py-2 rounded-lg bg-white text-black text-sm font-medium hover:bg-gray-200 transition-colors"
                >
                  Create a room
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {rooms.map((room) => (
                  <RoomCard
                    key={room.id}
                    room={room}
                    onJoin={() => router.push(`/room/${room.id}`)}
                    onRename={async (name) => {
                      await fetch(`/api/rooms/${room.id}`, {
                        method:  "PUT",
                        headers: { "Content-Type": "application/json" },
                        body:    JSON.stringify({ name }),
                      });
                      setRooms((rs) =>
                        rs.map((r) => r.id === room.id ? { ...r, name } : r)
                      );
                    }}
                  />
                ))}

                {/* "Create new" card */}
                <button
                  onClick={() => { setNewName(""); setNewLang("javascript"); setModalOpen(true); }}
                  className="rounded-xl border border-dashed border-[#3f3f46] bg-[#1c1c1e] p-5 flex flex-col items-center justify-center gap-2 text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors min-h-[140px]"
                >
                  <span className="text-3xl">+</span>
                  <span className="text-sm">New room</span>
                </button>
              </div>
            )}
          </>
        )}

        {/* ── Join by ID ───────────────────────────────────────────────────── */}
        <div className="border-t border-[#2d2d2d] pt-8">
          <p className="text-xs font-medium uppercase tracking-widest text-gray-500 mb-3">
            Join by room ID
          </p>
          <div className="flex gap-2 max-w-sm">
            <input
              type="text"
              placeholder="e.g. a1b2c3d4"
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              onKeyDown={handleJoinKey}
              className="flex-1 rounded-lg border border-[#3f3f46] bg-[#28282b] px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-gray-500 transition-colors"
            />
            <button
              onClick={joinRoom}
              disabled={!joinInput.trim() || !isSignedIn}
              className="rounded-lg border border-[#3f3f46] px-5 py-2.5 text-sm font-medium text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Join
            </button>
          </div>
          {!isSignedIn && isLoaded && (
            <p className="text-xs text-gray-600 mt-2">Sign in to join a room</p>
          )}
        </div>

      </div>

      {/* ── Create-room modal ─────────────────────────────────────────────── */}
      {modalOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
          onKeyDown={handleModalKey}
        >
          <div className="bg-[#1c1c1e] border border-[#2d2d2d] rounded-2xl p-6 w-full max-w-sm flex flex-col gap-5 shadow-2xl">
            <h3 className="text-base font-semibold">New room</h3>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-gray-500 uppercase tracking-widest">
                Room name
              </label>
              <input
                ref={nameInputRef}
                type="text"
                placeholder="Untitled Room"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="rounded-lg border border-[#3f3f46] bg-[#28282b] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-gray-500 transition-colors"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-gray-500 uppercase tracking-widest">
                Language
              </label>
              <select
                value={newLang}
                onChange={(e) => setNewLang(e.target.value)}
                className="rounded-lg border border-[#3f3f46] bg-[#28282b] px-3 py-2.5 text-sm text-gray-200 outline-none focus:border-gray-500 cursor-pointer transition-colors"
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setModalOpen(false)}
                className="flex-1 py-2.5 rounded-lg border border-[#3f3f46] text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={createRoom}
                disabled={creating}
                className="flex-1 py-2.5 rounded-lg bg-white text-black text-sm font-semibold hover:bg-gray-200 disabled:opacity-50 transition-colors"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── RoomCard ─────────────────────────────────────────────────────────────────

function RoomCard({
  room,
  onJoin,
  onRename,
}: {
  room:     Room;
  onJoin:   () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [editing,  setEditing]  = useState(false);
  const [nameVal,  setNameVal]  = useState(room.name);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 20);
  }

  async function commitEdit() {
    setEditing(false);
    const trimmed = nameVal.trim();
    if (trimmed && trimmed !== room.name) {
      await onRename(trimmed);
    } else {
      setNameVal(room.name); // reset on empty or unchanged
    }
  }

  function handleNameKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") { setEditing(false); setNameVal(room.name); }
  }

  return (
    <div className="rounded-xl border border-[#2d2d2d] bg-[#1c1c1e] p-5 flex flex-col gap-3 hover:border-[#3f3f46] transition-colors group">

      {/* Name row */}
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <input
            ref={inputRef}
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={handleNameKey}
            className="flex-1 bg-[#28282b] border border-[#3f3f46] rounded px-2 py-0.5 text-sm text-white outline-none"
          />
        ) : (
          <button
            onClick={startEdit}
            title="Click to rename"
            className="text-sm font-semibold text-white truncate text-left hover:text-gray-300 transition-colors"
          >
            {room.name}
          </button>
        )}
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border uppercase tracking-wide ${langBadge(room.language)}`}>
          {room.language}
        </span>
        <span className="text-[11px] text-gray-600">
          {formatDistanceToNow(new Date(room.last_active), { addSuffix: true })}
        </span>
        {room.member_count > 0 && (
          <span className="text-[11px] text-gray-600">
            · {room.member_count} {room.member_count === 1 ? "member" : "members"}
          </span>
        )}
      </div>

      {/* Action */}
      <button
        onClick={onJoin}
        className="mt-auto w-full py-2 rounded-lg border border-[#3f3f46] text-xs font-medium text-gray-400 group-hover:text-white group-hover:border-gray-500 transition-colors"
      >
        Join room →
      </button>

    </div>
  );
}
