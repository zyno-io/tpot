import { EventEmitter } from 'events';

import { TunnelError } from './Errors';
import * as CONTROL_CODES from './TunnelControlCodes';
import type { Tunnel } from './Tunnel';
import type { ClientHttpConnection } from './ClientHttpConnection';
import type debugFactory from 'debug';
import type net from 'net';

export class TunnelConversation extends EventEmitter {
    tunnel: Tunnel;
    id: number;
    mode: number | null = null;

    isTunnelConvoOpen = true;
    isClientConnected = true;
    hasEnded = false;
    bytesForwardedThroughTunnel = 0;
    bytesForwardedToClient = 0;

    log: debugFactory.Debugger;
    client!: ClientHttpConnection;
    clientSocket!: net.Socket;

    constructor(tunnel: Tunnel, id: number) {
        super();

        this.tunnel = tunnel;
        this.id = id;

        this.log = this.tunnel.log.extend('convo-' + this.id);
    }


    /******************
     * CLIENT HANDLERS
     *****************/

    handleNewConnection(clientConnection: ClientHttpConnection, initialData: Buffer): void {
        if (this.client)
            throw new Error('connection has already been established');

        this.client = clientConnection;
        this.clientSocket = this.client.socket;

        this.clientSocket.on('close', this.handleClientSocketClosed.bind(this));
        this.clientSocket.on('error', this.handleClientSocketError.bind(this));
        this.clientSocket.on('data', this.handleClientSocketDataReceived.bind(this));
        this.clientSocket.on('drain', this.handleClientSocketWriteDrained.bind(this));

        this.mode = CONTROL_CODES.TYPE_HTTP;

        const rawAddr = this.clientSocket.remoteAddress || '0.0.0.0';
        const ipv4Part = rawAddr.replace(/^.*:/, '');
        const remoteAddr = ipv4Part.includes('.') ? ipv4Part.split('.') : ['0', '0', '0', '0'];
        const remotePort = this.clientSocket.remotePort || 0;

        const controlBuffer = Buffer.allocUnsafe(10);
        controlBuffer.writeUInt8(CONTROL_CODES.MSG_CONTROL, 0);
        controlBuffer.writeUInt8(this.mode, 1);
        controlBuffer.writeUInt16LE(this.id, 2);
        controlBuffer.writeUInt8(parseInt(remoteAddr[0]) || 0, 4);
        controlBuffer.writeUInt8(parseInt(remoteAddr[1]) || 0, 5);
        controlBuffer.writeUInt8(parseInt(remoteAddr[2]) || 0, 6);
        controlBuffer.writeUInt8(parseInt(remoteAddr[3]) || 0, 7);
        controlBuffer.writeUInt16LE(remotePort, 8);
        this.tunnel.ws.send(controlBuffer);

        this.forwardDataThroughTunnel(initialData);
    }

    handleClientSocketDataReceived(data: Buffer): void {
        this.forwardDataThroughTunnel(data);
    }

    handleClientSocketWriteDrained(): void {
        this.sendTunnelControlMessage(CONTROL_CODES.CONVO_RESUME);
    }


    /******************
     * TUNNEL HANDLERS
     *****************/

    handleDataFromTunnel(data: Buffer): void {
        if (data[0] === CONTROL_CODES.CONVO_DATA)
            return this.forwardToClient(data.subarray(1));
        if (data[0] === CONTROL_CODES.CONVO_PAUSE)
            return this.invokeClientSocketMethod('pause');
        if (data[0] === CONTROL_CODES.CONVO_RESUME)
            return this.invokeClientSocketMethod('resume');
        if (data[0] === CONTROL_CODES.CONVO_CLOSED)
            return this.handleUpstreamSocketClosed();
        if (data[0] === CONTROL_CODES.CONVO_NOCONNECT)
            return this.handleUpstreamSocketCouldNotConnect();

        throw new TunnelError('unhandled conversation control code');
    }


    /******************
     * OUTPUT FUNCTIONS
     *****************/

    sendTunnelControlMessage(controlCode: number): void {
        if (!this.isTunnelConvoOpen) return;

        const outBuffer = Buffer.allocUnsafe(4);
        outBuffer.writeUInt8(CONTROL_CODES.MSG_CONVO, 0);
        outBuffer.writeUInt16LE(this.id, 1);
        outBuffer.writeUInt8(controlCode, 3);
        this.tunnel.ws.send(outBuffer);
    }

    forwardDataThroughTunnel(data: Buffer): void {
        if (!this.isTunnelConvoOpen) return;

        const outBuffer = Buffer.allocUnsafe(4 + data.length);
        outBuffer.writeUInt8(CONTROL_CODES.MSG_CONVO, 0);
        outBuffer.writeUInt16LE(this.id, 1);
        outBuffer.writeUInt8(CONTROL_CODES.CONVO_DATA, 3);
        data.copy(outBuffer, 4);
        this.tunnel.ws.send(outBuffer);

        this.bytesForwardedThroughTunnel += data.length;
    }

    forwardToClient(data: Buffer): void {
        if (!this.isClientConnected) return;

        const shouldContinueWriting = this.clientSocket.write(data);
        if (!shouldContinueWriting) this.sendTunnelControlMessage(CONTROL_CODES.CONVO_PAUSE);

        this.bytesForwardedToClient += data.length;
    }

    invokeClientSocketMethod(method: 'pause' | 'resume'): void {
        if (!this.isClientConnected) return;
        this.clientSocket[method]();
    }


    /******************
     * TEARDOWN
     *****************/

    handleClientSocketClosed(): void {
        this.isClientConnected = false;
        this.sendTunnelControlMessage(CONTROL_CODES.CONVO_CLOSED);
        this.checkForEnd();
    }

    handleClientSocketError(_err: Error): void {
        this.handleClientSocketClosed();
    }

    handleUpstreamSocketClosed(): void {
        this.isTunnelConvoOpen = false;
        this.isClientConnected && this.clientSocket.end();
        this.checkForEnd();
    }

    handleUpstreamSocketCouldNotConnect(): void {
        if (this.isClientConnected) {
            if (this.mode === CONTROL_CODES.TYPE_HTTP) {
                this.client.handleHttpError({
                    statusCode: 503,
                    message: 'tunnel could not connect to upstream'
                });
            }

            this.clientSocket.end();
        }
    }

    terminate(): void {
        this.isTunnelConvoOpen = false;

        if (this.isClientConnected) {
            if (this.mode === CONTROL_CODES.TYPE_HTTP && this.bytesForwardedToClient === 0) {
                this.client.handleHttpError({
                    statusCode: 503,
                    message: 'tunnel disconnected suddenly'
                });
            } else {
                this.clientSocket.end();
            }
        }

        this.checkForEnd();
    }

    checkForEnd(): void {
        if (this.isTunnelConvoOpen) return;
        if (this.isClientConnected) return;
        if (this.hasEnded) return;
        this.hasEnded = true;
        this.emit('end');

        this.log('transmitted %d bytes upstream, %d bytes downstream', this.bytesForwardedThroughTunnel, this.bytesForwardedToClient);
    }
}
