import { EventEmitter } from 'events';
import debugFactory from 'debug';
import net from 'net';

import * as CONTROL_CODES from './TunnelControlCodes';
import type { Client } from './Client';

export class Conversation extends EventEmitter {
    client: Client;
    id: number;
    log: debugFactory.Debugger;

    isTunnelConvoOpen = true;
    isUpstreamConnected = false;
    initialBuffer: Buffer[] | null = [];
    hasEnded = false;

    bytesForwardedThroughTunnel = 0;
    bytesForwardedUpstream = 0;

    upstreamSocket!: net.Socket;
    clientIp!: string;
    clientPort!: number;

    constructor(type: string, client: Client, id: number) {
        super();

        this.client = client;
        this.id = id;

        this.log = debugFactory(type + '-' + id);
    }


    /******************
     * SETUP
     *****************/

    handleRequest(sourceInfo: Buffer): void {
        const ipComponents: number[] = [];
        ipComponents[0] = sourceInfo.readUInt8(0);
        ipComponents[1] = sourceInfo.readUInt8(1);
        ipComponents[2] = sourceInfo.readUInt8(2);
        ipComponents[3] = sourceInfo.readUInt8(3);

        this.clientIp = ipComponents.join('.');
        this.clientPort = sourceInfo.readUInt16LE(4);

        this.log('handling request from ' + this.clientIp + ':' + this.clientPort);

        const target = this.client.options.target as { host: string; port: number };
        this.upstreamSocket = net.connect(target.port, target.host);
        this.upstreamSocket.on('error', this.handleUpstreamSocketError.bind(this));
        this.upstreamSocket.on('close', this.handleUpstreamSocketClosed.bind(this));
        this.upstreamSocket.on('connect', this.handleUpstreamSocketConnected.bind(this));
        this.upstreamSocket.on('data', this.handleUpstreamSocketDataReceived.bind(this));
        this.upstreamSocket.on('drain', this.handleUpstreamSocketWriteDrained.bind(this));

        // TODO: add connection timeout
    }


    /******************
     * LOCAL SOCKET HANDLERS
     *****************/

    handleUpstreamSocketConnected(): void {
        this.log('upstream ' + this.upstreamSocket.remoteAddress + ':' + this.upstreamSocket.remotePort + ' connected from ' + this.upstreamSocket.localAddress + ':' + this.upstreamSocket.localPort);
        this.isUpstreamConnected = true;

        const initialBuffer = Buffer.concat(this.initialBuffer!);
        this.upstreamSocket.write(initialBuffer);

        this.initialBuffer = null;
    }

    handleUpstreamSocketDataReceived(data: Buffer): void {
        this.forwardDataThroughTunnel(data);
    }

    handleUpstreamSocketWriteDrained(): void {
        this.sendTunnelControlMessage(CONTROL_CODES.CONVO_RESUME);
    }


    /******************
     * TUNNEL HANDLERS
     *****************/

    handleDataFromTunnel(data: Buffer): void {
        if (data[0] === CONTROL_CODES.CONVO_DATA)
            return this.forwardUpstream(data.subarray(1));
        if (data[0] === CONTROL_CODES.CONVO_PAUSE)
            return this.invokeUpstreamSocketMethod('pause');
        if (data[0] === CONTROL_CODES.CONVO_RESUME)
            return this.invokeUpstreamSocketMethod('resume');
        if (data[0] === CONTROL_CODES.CONVO_CLOSED)
            return this.handleTunnelClientClosed();

        throw new Error('unhandled conversation control code');
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
        this.client.ws!.send(outBuffer);
    }

    forwardDataThroughTunnel(data: Buffer): void {
        if (!this.isTunnelConvoOpen) return;

        const outBuffer = Buffer.allocUnsafe(4 + data.length);
        outBuffer.writeUInt8(CONTROL_CODES.MSG_CONVO, 0);
        outBuffer.writeUInt16LE(this.id, 1);
        outBuffer.writeUInt8(CONTROL_CODES.CONVO_DATA, 3);
        data.copy(outBuffer, 4);
        this.client.ws!.send(outBuffer);

        this.bytesForwardedThroughTunnel += data.length;
    }

    forwardUpstream(data: Buffer): void {
        if (!this.isUpstreamConnected) {
            if (this.initialBuffer != null) {
                this.initialBuffer.push(data);
            }

            return;
        }

        const shouldContinueWriting = this.upstreamSocket.write(data);
        if (!shouldContinueWriting) this.sendTunnelControlMessage(CONTROL_CODES.CONVO_PAUSE);

        this.bytesForwardedUpstream += data.length;
    }

    invokeUpstreamSocketMethod(method: 'pause' | 'resume'): void {
        if (!this.isUpstreamConnected) return;
        this.upstreamSocket[method]();
    }


    /******************
     * TEARDOWN
     *****************/

    handleTunnelClientClosed(): void {
        this.log('downstream client disconnected');
        this.isTunnelConvoOpen = false;
        this.isUpstreamConnected && this.upstreamSocket.end();
        this.checkForEnd();
    }

    handleUpstreamSocketError(err: Error): void {
        this.log('upstream socket error', err);

        if (!this.isUpstreamConnected) {
            this.sendTunnelControlMessage(CONTROL_CODES.CONVO_NOCONNECT);
            return;
        }

        this.isUpstreamConnected = false;
        this.closeTunnelConvo();
    }

    handleUpstreamSocketClosed(hadError: boolean): void {
        if (hadError)
            this.log('upstream disconnected with error');
        else
            this.log('upstream disconnected');

        this.isUpstreamConnected = false;
        this.closeTunnelConvo();
    }

    closeTunnelConvo(): void {
        if (this.isTunnelConvoOpen) {
            this.sendTunnelControlMessage(CONTROL_CODES.CONVO_CLOSED);
            this.isTunnelConvoOpen = false;
        }

        this.checkForEnd();
    }

    checkForEnd(): void {
        if (this.isTunnelConvoOpen) return;
        if (this.isUpstreamConnected) return;
        if (this.hasEnded) return;
        this.hasEnded = true;
        this.emit('end');

        this.log('transmitted %d bytes upstream, %d bytes downstream', this.bytesForwardedUpstream, this.bytesForwardedThroughTunnel);
    }
}
