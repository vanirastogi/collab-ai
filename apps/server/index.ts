import express from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import cors from "cors";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Room {
  code: string;
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

interface CodeChangePayload {
  roomId: string;
  code: string;
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

// ─── In-memory rooms store ────────────────────────────────────────────────────

const rooms: Record<string, Room> = {};

function getOrCreateRoom(roomId: string): Room {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      code: "",
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
      code: room.code,
      language: room.language,
      whiteboardData: room.whiteboardData,
      userCount: room.users.size,
    });

    // Broadcast updated user count to everyone else in the room
    socket.to(roomId).emit("user-count", room.users.size);
  });

  // ── code-change ────────────────────────────────────────────────────────────
  socket.on("code-change", ({ roomId, code }: CodeChangePayload) => {
    if (!roomId || !rooms[roomId]) return;

    rooms[roomId].code = code;
    // Broadcast to every other socket in the room
    socket.to(roomId).emit("code-change", code);
  });

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
