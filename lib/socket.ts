import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export function connectSocket(): Socket {
  if (socket) return socket;

  const url = process.env.NEXT_PUBLIC_SERVER_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SERVER_URL is not defined.");

  socket = io(url, {
    transports: ["websocket"],
    autoConnect: true,
  });
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
