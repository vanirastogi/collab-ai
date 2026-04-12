import { io, Socket } from "socket.io-client";

/**
 * Singleton pattern: a module-level variable that holds the one shared
 * instance of the socket. Because JavaScript modules are evaluated once and
 * then cached, this variable persists for the lifetime of the browser tab.
 * The first caller to `getSocket()` pays the cost of opening the connection;
 * every subsequent caller receives the same already-connected object without
 * creating a new one. This prevents duplicate connections, duplicate event
 * listeners, and wasted resources that would otherwise appear if the socket
 * were created inside a React component or hook directly.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SERVER_URL;
    if (!url) {
      throw new Error(
        "NEXT_PUBLIC_SERVER_URL is not defined. " +
          "Add it to your .env.local file."
      );
    }

    socket = io(url, {
      transports: ["websocket"], // skip the HTTP long-polling upgrade handshake
      autoConnect: true,
    });
  }

  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
