"use client";

import { useState, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

export default function Home() {
  const router = useRouter();
  const [roomInput, setRoomInput] = useState("");

  function createRoom() {
    const id = uuidv4().slice(0, 8);
    router.push(`/room/${id}`);
  }

  function joinRoom() {
    const id = roomInput.trim();
    if (id) router.push(`/room/${id}`);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") joinRoom();
  }

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 w-full max-w-md p-10 flex flex-col gap-8">

        {/* Header */}
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">
            Collab.ai
          </h1>
          <p className="text-sm text-gray-500">
            Real-time collaborative code editor and whiteboard
          </p>
        </div>

        {/* Divider */}
        <div className="border-t border-gray-100" />

        {/* Create room */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-widest text-gray-400">
            New room
          </span>
          <button
            onClick={createRoom}
            className="w-full rounded-xl bg-gray-900 text-white text-sm font-medium py-3 hover:bg-gray-700 active:scale-[0.98] transition-all"
          >
            Create new room
          </button>
        </div>

        {/* Divider with label */}
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-gray-100" />
          <span className="text-xs text-gray-400">or join existing</span>
          <div className="flex-1 border-t border-gray-100" />
        </div>

        {/* Join room */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-widest text-gray-400">
            Room ID
          </span>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="e.g. a1b2c3d4"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-gray-400 focus:bg-white transition-colors"
            />
            <button
              onClick={joinRoom}
              disabled={!roomInput.trim()}
              className="rounded-xl border border-gray-200 px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Join
            </button>
          </div>
        </div>

      </div>
    </main>
  );
}
