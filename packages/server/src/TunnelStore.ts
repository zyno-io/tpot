import type net from 'net';
import type WebSocket from 'ws';
import type { Tunnel } from './Tunnel';
import type { ClientHttpConnection } from './ClientHttpConnection';

export interface TunnelEntity {
    cxn: ClientHttpConnection;
    socket: net.Socket;
    ws?: WebSocket;
    tunnel?: Tunnel;
}

class TunnelStore {
    tunnels: Record<string, TunnelEntity> = {};

    static instance = new TunnelStore();
}

export { TunnelStore };
