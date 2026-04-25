import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

function createSocket(token: string): Socket {
  const url = process.env.NEXT_PUBLIC_SERVER_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SERVER_URL is not defined.");

  return io(url, {
    auth: { token },
    transports: ["websocket"],
    autoConnect: true,
  });
}

/**
 * Call once after the Clerk token is available (e.g. in a useEffect).
 * Subsequent calls with the same token are no-ops and return the existing socket.
 * If the token rotates, the old socket is disconnected and a new one is created.
 */
export function connectSocket(token: string): Socket {
  if (socket) {
    const current = (socket.auth as Record<string, string>).token;
    if (current === token) return socket; // already connected with this token
    socket.disconnect();
    socket = null;
  }
  socket = createSocket(token);
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
