import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { Server, Socket } from "socket.io";
import cors from "cors";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setupWSConnection } = require("y-websocket/bin/utils");

// ─── Types ────────────────────────────────────────────────────────────────────

interface Room {
  language: string;
  whiteboardData: string;
  users: Set<string>;
}

interface SocketWithRoom extends Socket {
  currentRoom?: string;
}

interface JoinRoomPayload {
  roomId: string;
  username?: string;
}


interface LanguageChangePayload {
  roomId: string;
  language: string;
}

interface WhiteboardChangePayload {
  roomId: string;
  whiteboardData: string;
}

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ─── Yjs WebSocket server ─────────────────────────────────────────────────────
// Runs on the same HTTP server as Socket.IO but on the /yjs/* path.
// setupWSConnection handles the entire Yjs sync protocol — room names are
// extracted from the URL automatically (e.g. /yjs/ROOM_ID).

const yWss = new WebSocketServer({ noServer: true });
yWss.on("connection", setupWSConnection);

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname.startsWith("/yjs")) {
    yWss.handleUpgrade(request, socket, head, (ws) => {
      yWss.emit("connection", ws, request);
    });
  }
});

// ─── In-memory rooms store ────────────────────────────────────────────────────

const rooms: Record<string, Room> = {};
const roomDSA: Record<string, Array<{problemId:number, userId:string, userName:string}>> = {};

function getOrCreateRoom(roomId: string): Room {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      language: "javascript",
      whiteboardData: "",
      users: new Set(),
    };
  }
  return rooms[roomId];
}

// ─── REST health check ────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: Object.keys(rooms).length });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on("connection", (rawSocket: Socket) => {
  const socket = rawSocket as SocketWithRoom;
  console.log(`[+] Connected: ${socket.id}`);

  // ── join-room ──────────────────────────────────────────────────────────────
  socket.on("join-room", ({ roomId }: JoinRoomPayload) => {
    if (!roomId) return;

    // Leave any previous room this socket was in
    if (socket.currentRoom && socket.currentRoom !== roomId) {
      leaveRoom(socket, socket.currentRoom);
    }

    socket.join(roomId);
    socket.currentRoom = roomId;

    const room = getOrCreateRoom(roomId);
    room.users.add(socket.id);

    console.log(
      `[room:${roomId}] ${socket.id} joined — ${room.users.size} user(s)`
    );

    // Send current room state back to the joiner only
    socket.emit("room-state", {
      code: "",        // code is now managed by Yjs, not in-memory
      language: room.language,
      whiteboardData: room.whiteboardData,
      userCount: room.users.size,
    });

    // Broadcast updated user count to everyone else in the room
    socket.to(roomId).emit("user-count", room.users.size);
  });

  // code-change is now handled by Yjs — no socket handler needed.

  // ── language-change ────────────────────────────────────────────────────────
  socket.on("language-change", ({ roomId, language }: LanguageChangePayload) => {
    if (!roomId || !rooms[roomId]) return;

    rooms[roomId].language = language;
    socket.to(roomId).emit("language-change", language);
  });

  // ── whiteboard-change ──────────────────────────────────────────────────────
  socket.on(
    "whiteboard-change",
    ({ roomId, whiteboardData }: WhiteboardChangePayload) => {
      if (!roomId || !rooms[roomId]) return;

      rooms[roomId].whiteboardData = whiteboardData;
      socket.to(roomId).emit("whiteboard-change", whiteboardData);
    }
  );

  // ── cursor-move ────────────────────────────────────────────────────────────
  socket.on(
    "cursor-move",
    ({ roomId, position }: { roomId: string; position: { lineNumber: number; column: number } }) => {
      if (!roomId || !rooms[roomId]) return;
      // Broadcast the mover's socket ID so the receiver can label the cursor
      socket.to(roomId).emit("cursor-move", { userId: socket.id, position });
    }
  );

  // ── dsa:solve ──────────────────────────────────────────────────────────────
  socket.on('dsa:solve', ({ roomId, problemId, userId, userName }) => {
    if (!roomDSA[roomId]) roomDSA[roomId] = [];
    const exists = roomDSA[roomId].find(s => 
      s.problemId === problemId && s.userId === userId);
    if (!exists) roomDSA[roomId].push({ problemId, userId, userName });
    io.to(roomId).emit('dsa:room_state', roomDSA[roomId]);
  });

  // ── dsa:request_state ──────────────────────────────────────────────────────
  socket.on('dsa:request_state', ({ roomId }) => {
    socket.emit('dsa:room_state', roomDSA[roomId] || []);
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    if (socket.currentRoom) {
      leaveRoom(socket, socket.currentRoom);
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function leaveRoom(socket: SocketWithRoom, roomId: string): void {
  const room = rooms[roomId];
  if (!room) return;

  room.users.delete(socket.id);
  socket.leave(roomId);
  console.log(
    `[room:${roomId}] ${socket.id} left — ${room.users.size} user(s) remaining`
  );

  if (room.users.size === 0) {
    // Clean up empty rooms to free memory
    delete rooms[roomId];
    console.log(`[room:${roomId}] empty — removed from memory`);
  } else {
    // Notify remaining users of the new count and remove the stale cursor
    socket.to(roomId).emit("user-count", room.users.size);
    socket.to(roomId).emit("cursor-leave", { userId: socket.id });
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3001;

httpServer.listen(PORT, () => {
  console.log(`Socket.IO server listening on http://localhost:${PORT}`);
});
