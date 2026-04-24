"use client";

import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";

interface DSALadderProps {
  socket: Socket;
  roomId: string;
  userId: string;
  userName: string;
}

interface RoomSolve {
  problemId: number;
  userId: string;
  userName: string;
}

interface Problem {
  id: number;
  slug: string;
  title: string;
  difficulty: string;
  topic: string;
  xp: number;
}

function getRank(xp: number) {
  if (xp >= 1000) return "Legend";
  if (xp >= 750) return "Master";
  if (xp >= 500) return "Expert";
  if (xp >= 300) return "Solver";
  if (xp >= 150) return "Coder";
  if (xp >= 50) return "Apprentice";
  return "Newbie";
}

function getDiffColor(diff: string) {
  if (diff === 'Easy') return 'text-green-400 bg-green-400/10 border-green-400/20';
  if (diff === 'Medium') return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20';
  return 'text-red-400 bg-red-400/10 border-red-400/20';
}

export default function DSALadder({ socket, roomId, userId, userName }: DSALadderProps) {
  const [problems, setProblems] = useState<Problem[]>([]);
  const [solvedSlugs, setSolvedSlugs] = useState<Set<string>>(new Set());
  const [roomSolves, setRoomSolves] = useState<RoomSolve[]>([]);
  const [totalXP, setTotalXP] = useState(0);
  const [streak, setStreak] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [lcUsernameInput, setLcUsernameInput] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // Add Problem State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newProbTitle, setNewProbTitle] = useState("");
  const [newProbSlug, setNewProbSlug] = useState("");
  const [newProbDiff, setNewProbDiff] = useState("Easy");
  const [newProbTopic, setNewProbTopic] = useState("");
  const [addingProb, setAddingProb] = useState(false);

  useEffect(() => {
    // 0. Fetch problems
    fetch("/api/dsa/problems")
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setProblems(data);
      });

    // 1. Fetch progress
    fetch("/api/dsa/progress")
      .then(r => r.json())
      .then(data => {
        if (data.solved) setSolvedSlugs(new Set(data.solved));
        if (data.totalXP) setTotalXP(data.totalXP);
        if (data.streak) setStreak(data.streak);
      });

    // 2. Request room state
    socket.emit('dsa:request_state', { roomId });

    // 3. Fire and forget sync
    fetch("/api/dsa/sync", { method: "POST" })
      .then(r => r.json())
      .then(data => {
        if (data.newlySynced > 0) {
          showToast(`Synced ${data.newlySynced} recent solves from LeetCode!`);
          // Refresh progress to get new XP/solved
          fetch("/api/dsa/progress")
            .then(r => r.json())
            .then(prog => {
              if (prog.solved) setSolvedSlugs(new Set(prog.solved));
              if (prog.totalXP) setTotalXP(prog.totalXP);
              if (prog.streak) setStreak(prog.streak);
            });
        }
      });
  }, [roomId, socket]);

  useEffect(() => {
    const handleRoomState = (solves: RoomSolve[]) => {
      setRoomSolves(solves);
    };
    socket.on('dsa:room_state', handleRoomState);
    return () => {
      socket.off('dsa:room_state', handleRoomState);
    };
  }, [socket]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function handleManualSolve(problem: Problem) {
    const res = await fetch("/api/dsa/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: problem.slug, roomId })
    });
    const data = await res.json();
    if (data.success) {
      setSolvedSlugs(prev => new Set(prev).add(problem.slug));
      setTotalXP(prev => prev + data.xp);
      socket.emit('dsa:solve', { roomId, problemId: problem.id, userId, userName });
    }
  }

  async function handleLinkSubmit() {
    if (!lcUsernameInput.trim()) return;
    setSyncing(true);
    await fetch("/api/dsa/link-leetcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lcUsername: lcUsernameInput.trim() })
    });
    
    // Trigger a sync immediately
    const res = await fetch("/api/dsa/sync", { method: "POST" });
    const data = await res.json();
    
    setSyncing(false);
    setShowLinkModal(false);

    if (data.newlySynced > 0) {
      showToast(`Linked! Synced ${data.newlySynced} solves.`);
      // Refresh
      fetch("/api/dsa/progress")
        .then(r => r.json())
        .then(prog => {
          if (prog.solved) setSolvedSlugs(new Set(prog.solved));
          if (prog.totalXP) setTotalXP(prog.totalXP);
          if (prog.streak) setStreak(prog.streak);
        });
    } else {
      showToast("Linked successfully (no new solves found).");
    }
  }

  async function forceSync() {
    setSyncing(true);
    const res = await fetch("/api/dsa/sync", { method: "POST" });
    const data = await res.json();
    setSyncing(false);
    
    if (data.error === "no username linked") {
      setShowLinkModal(true);
    } else if (data.newlySynced > 0) {
      showToast(`Synced ${data.newlySynced} solves!`);
      // Refresh
      fetch("/api/dsa/progress")
        .then(r => r.json())
        .then(prog => {
          if (prog.solved) setSolvedSlugs(new Set(prog.solved));
          if (prog.totalXP) setTotalXP(prog.totalXP);
          if (prog.streak) setStreak(prog.streak);
        });
    } else {
      showToast("Up to date!");
    }
  }

  async function handleAddProblem() {
    if (!newProbTitle.trim() || !newProbSlug.trim() || !newProbTopic.trim()) {
      showToast("Please fill in all fields");
      return;
    }
    setAddingProb(true);
    const res = await fetch("/api/dsa/problems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: newProbTitle.trim(),
        slug: newProbSlug.trim(),
        difficulty: newProbDiff,
        topic: newProbTopic.trim()
      })
    });
    const data = await res.json();
    setAddingProb(false);
    
    if (data.error) {
      showToast(`Error: ${data.error}`);
    } else {
      showToast("Problem added successfully!");
      setProblems(prev => [...prev, data]);
      setShowAddModal(false);
      setNewProbTitle("");
      setNewProbSlug("");
      setNewProbDiff("Easy");
      setNewProbTopic("");
    }
  }

  async function handleDeleteProblem(problemId: number, problemSlug: string) {
    if (!confirm("Are you sure you want to delete this problem?")) return;
    
    const res = await fetch(`/api/dsa/problems/${problemId}`, { method: "DELETE" });
    if (res.ok) {
      setProblems(prev => prev.filter(p => p.id !== problemId));
      
      // If the user had solved it, we should re-fetch progress so XP and streak update
      if (solvedSlugs.has(problemSlug)) {
        fetch("/api/dsa/progress")
          .then(r => r.json())
          .then(prog => {
            if (prog.solved) setSolvedSlugs(new Set(prog.solved));
            if (prog.totalXP !== undefined) setTotalXP(prog.totalXP);
            if (prog.streak !== undefined) setStreak(prog.streak);
          });
      }
      showToast("Problem deleted.");
    } else {
      showToast("Failed to delete problem.");
    }
  }

  const solvedCount = solvedSlugs.size;
  const totalCount = problems.length || 30; // fallback to 30 to avoid 0/0 early on
  const progressPct = Math.min(100, Math.round((solvedCount / totalCount) * 100));

  return (
    <div className="flex flex-col h-full bg-[#18181b] overflow-hidden">
      
      {/* Top stats bar */}
      <div className="flex-shrink-0 bg-[#1c1c1e] border-b border-[#2d2d2d] p-4 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div className="flex flex-col">
            <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Progress</span>
            <span className="text-sm font-medium text-white">{solvedCount} / {totalCount}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Streak</span>
            <span className="text-sm font-medium text-orange-400">🔥 {streak} day{streak !== 1 && 's'}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">XP</span>
            <span className="text-sm font-medium text-blue-400">{totalXP}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Rank</span>
            <span className="text-sm font-medium text-purple-400">{getRank(totalXP)}</span>
          </div>
        </div>
        
        <div className="flex gap-2">
          <button 
            onClick={() => setShowAddModal(true)}
            className="px-3 py-1.5 rounded bg-blue-600/20 border border-blue-600/30 text-xs font-medium text-blue-400 hover:bg-blue-600/30 transition-colors flex items-center gap-1"
          >
            <span className="text-base leading-none">+</span> Add Problem
          </button>
          <button 
            onClick={forceSync}
            disabled={syncing}
            className="px-3 py-1.5 rounded bg-[#28282b] border border-[#3f3f46] text-xs font-medium text-gray-300 hover:text-white hover:bg-[#3f3f46] transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {syncing ? <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"/> : '🔄'}
            Sync LeetCode
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-[#28282b] w-full flex-shrink-0">
        <div 
          className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-1000" 
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Problem List */}
      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8">
        
        {['Easy', 'Medium', 'Hard'].map((diffGroup) => {
          const groupProbs = problems.filter(p => p.difficulty === diffGroup);
          if (groupProbs.length === 0) return null;

          return (
            <div key={diffGroup} className="flex flex-col gap-3">
              <h3 className="text-lg font-bold text-white mb-2">{diffGroup} Problems</h3>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {groupProbs.map((prob, idx) => {
                  const isSolved = solvedSlugs.has(prob.slug);
                  
                  // Unlock logic: previous problem in this specific group must be solved
                  // (Or just 0th is always unlocked)
                  const isUnlocked = idx === 0 || solvedSlugs.has(groupProbs[idx - 1].slug);
                  
                  // Check if a roommate solved it
                  const roommateSolves = roomSolves.filter(s => s.problemId === prob.id && s.userId !== userId);

                  return (
                    <div 
                      key={prob.id}
                      className={`relative flex flex-col p-4 rounded-xl border transition-colors ${
                        isSolved 
                          ? 'bg-[#1c1c1e]/50 border-green-500/30' 
                          : isUnlocked 
                            ? 'bg-[#1c1c1e] border-[#3f3f46] hover:border-gray-500' 
                            : 'bg-[#1c1c1e]/30 border-[#2d2d2d] opacity-60'
                      }`}
                    >
                      {!isUnlocked && !isSolved && (
                        <div className="absolute top-4 right-4 text-gray-500 text-sm">
                          🔒 Locked
                        </div>
                      )}

                      <div className="flex items-start justify-between gap-4 mb-3">
                        <div className="flex flex-col gap-1">
                          <span className="font-semibold text-white flex items-center gap-2">
                            {isSolved && <span className="text-green-500">✓</span>}
                            {prob.title}
                          </span>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className={`text-[10px] px-2 py-0.5 rounded border uppercase tracking-wider font-semibold ${getDiffColor(prob.difficulty)}`}>
                              {prob.difficulty}
                            </span>
                            <span className="text-xs text-gray-400 bg-[#28282b] px-2 py-0.5 rounded">
                              {prob.topic}
                            </span>
                            <span className="text-xs text-blue-400 font-medium bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                              +{prob.xp} XP
                            </span>
                          </div>
                        </div>
                        <button 
                          onClick={() => handleDeleteProblem(prob.id, prob.slug)}
                          className="text-gray-500 hover:text-red-400 transition-colors p-1"
                          title="Delete problem"
                        >
                          ✕
                        </button>
                      </div>

                      {/* Roommate solve indicator */}
                      {roommateSolves.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-3">
                          {roommateSolves.map((s, i) => (
                            <span key={i} className="text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded">
                              {s.userName} solved
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="mt-auto flex gap-2 pt-2">
                        <button
                          onClick={() => window.open(`https://leetcode.com/problems/${prob.slug}`, '_blank')}
                          disabled={!isUnlocked}
                          className="flex-1 py-1.5 text-xs font-medium rounded bg-[#28282b] text-gray-300 hover:text-white hover:bg-[#3f3f46] border border-[#3f3f46] disabled:opacity-50 transition-colors"
                        >
                          {isSolved ? "Review on LeetCode ↗" : "Open on LeetCode ↗"}
                        </button>
                        {!isSolved && isUnlocked && (
                          <button
                            onClick={() => handleManualSolve(prob)}
                            className="flex-1 py-1.5 text-xs font-medium rounded bg-green-600/20 text-green-400 border border-green-600/30 hover:bg-green-600/30 transition-colors"
                          >
                            Mark Solved
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Link Modal */}
      {showLinkModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#1c1c1e] border border-[#2d2d2d] rounded-2xl p-6 w-full max-w-sm flex flex-col gap-4 shadow-2xl">
            <h3 className="text-base font-semibold text-white">Link LeetCode Account</h3>
            <p className="text-sm text-gray-400 leading-relaxed">
              Enter your LeetCode username to automatically sync your solved problems.
            </p>
            <input 
              type="text"
              value={lcUsernameInput}
              onChange={e => setLcUsernameInput(e.target.value)}
              placeholder="e.g. neetcode"
              className="rounded-lg border border-[#3f3f46] bg-[#28282b] px-3 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-gray-400"
            />
            <div className="flex gap-2 pt-2">
              <button 
                onClick={() => setShowLinkModal(false)}
                className="flex-1 py-2 rounded-lg border border-[#3f3f46] text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleLinkSubmit}
                disabled={syncing || !lcUsernameInput.trim()}
                className="flex-1 py-2 rounded-lg bg-white text-black text-sm font-semibold hover:bg-gray-200 disabled:opacity-50 transition-colors"
              >
                {syncing ? "Linking..." : "Link Account"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Problem Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#1c1c1e] border border-[#2d2d2d] rounded-2xl p-6 w-full max-w-sm flex flex-col gap-4 shadow-2xl">
            <h3 className="text-base font-semibold text-white">Add Custom Problem</h3>
            
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-gray-500 uppercase tracking-wider font-semibold">LeetCode Slug</label>
              <input 
                type="text"
                value={newProbSlug}
                onChange={e => setNewProbSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                placeholder="e.g. two-sum"
                className="rounded-lg border border-[#3f3f46] bg-[#28282b] px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-gray-400"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Title</label>
              <input 
                type="text"
                value={newProbTitle}
                onChange={e => setNewProbTitle(e.target.value)}
                placeholder="e.g. Two Sum"
                className="rounded-lg border border-[#3f3f46] bg-[#28282b] px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-gray-400"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Difficulty</label>
              <select 
                value={newProbDiff}
                onChange={e => setNewProbDiff(e.target.value)}
                className="rounded-lg border border-[#3f3f46] bg-[#28282b] px-3 py-2 text-sm text-white outline-none focus:border-gray-400"
              >
                <option value="Easy">Easy (10 XP)</option>
                <option value="Medium">Medium (25 XP)</option>
                <option value="Hard">Hard (50 XP)</option>
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Topic</label>
              <input 
                type="text"
                value={newProbTopic}
                onChange={e => setNewProbTopic(e.target.value)}
                placeholder="e.g. Arrays, Graph..."
                className="rounded-lg border border-[#3f3f46] bg-[#28282b] px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-gray-400"
              />
            </div>

            <div className="flex gap-2 pt-2 mt-2">
              <button 
                onClick={() => setShowAddModal(false)}
                className="flex-1 py-2 rounded-lg border border-[#3f3f46] text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleAddProblem}
                disabled={addingProb}
                className="flex-1 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                {addingProb ? "Adding..." : "Add Problem"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-sm px-4 py-2 rounded-full shadow-lg pointer-events-none animate-bounce">
          {toast}
        </div>
      )}

    </div>
  );
}
