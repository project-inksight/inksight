import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { WSMessage } from '../../shared/types.js';

class WebSocketHub {
  private wss: WebSocketServer | null = null;
  private onConnectCallback: ((ws: WebSocket) => void) | null = null;

  public attach(server: Server, onConnect?: (ws: WebSocket) => void): void {
    this.onConnectCallback = onConnect || null;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      if (this.onConnectCallback) {
        try {
          this.onConnectCallback(ws);
        } catch (err) {
          console.error('[WSHub] Error in onConnectCallback:', err);
        }
      }

      ws.on('error', (err) => {
        console.error('[WSHub] Client socket error:', err.message);
      });
    });

    console.log('[WSHub] WebSocket real-time hub attached at /ws');
  }

  public sendToClient(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  public broadcast(message: WSMessage): void {
    if (!this.wss) return;
    const payload = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  public notify(
    level: 'info' | 'warning' | 'error' | 'alert',
    title: string,
    message: string
  ): void {
    this.broadcast({
      type: 'NOTIFICATION',
      level,
      title,
      message,
      timestamp: Date.now(),
    });
  }
}

export const wsHub = new WebSocketHub();

