// (ws ships no types, and @types/ws would pull in @types/node: only what host/ws.ts uses)
declare module 'ws' {
  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string): void;
    close(): void;
    on(event: 'message', f: (data: { toString(): string }) => void): this;
    on(event: 'close', f: () => void): this;
    on(event: 'error', f: (e: Error) => void): this;
  }
  export class WebSocketServer {
    constructor(opts: { host?: string; port: number; perMessageDeflate?: boolean | object });
    on(event: 'connection', f: (ws: WebSocket, req: { socket: { remoteAddress?: string; bytesWritten: number } }) => void): this;
    on(event: 'listening', f: () => void): this;
    on(event: 'error', f: (e: Error) => void): this;
    address(): { port: number };
    close(): void;
  }
}
