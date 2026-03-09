import { Conversation } from './Conversation';
import type { Client } from './Client';

export class HttpConversation extends Conversation {
    isInspectionEnabled = true;
    isRequestInFlight = false;
    isInFlightRequestKeepAlive = false;
    isInFlightRequestChunked = false;
    expectedChunkBytesRemaining = 0;
    queuedChunks: Buffer[] = [];
    pendingRequestLog: string | null = null;
    pendingRequestTime: number = 0;
    isWebSocket = false;
    wsConnectedTime = 0;

    constructor(client: Client, id: number) {
        super('http', client, id);
    }

    forwardUpstream(data: Buffer): void {
        if (this.isInspectionEnabled) {
            if (!this.isRequestInFlight) {
                const processed = this.processInitialRequestData(data);
                if (!processed) return;
                data = processed;
            }

            if (this.isInFlightRequestKeepAlive) {
                return this.processDataForKARequest(data);
            }
        }

        super.forwardUpstream(data);
    }

    handleUpstreamSocketDataReceived(data: Buffer): void {
        if (this.pendingRequestLog) {
            const firstLine = data.subarray(0, Math.min(data.length, 128));
            const match = firstLine.toString('utf8').match(/^HTTP\/\S+ (\d{3})/);
            if (match) {
                const elapsed = Date.now() - this.pendingRequestTime;
                const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
                if (this.isWebSocket && match[1] === '101') {
                    console.log(`[${ts}] WS#${this.id} ${this.pendingRequestLog} connected (${elapsed}ms)`);
                    this.wsConnectedTime = Date.now();
                } else {
                    console.log(`[${ts}] ${match[1]} ${this.pendingRequestLog} ${elapsed}ms`);
                }
                this.pendingRequestLog = null;
            }
        }
        super.handleUpstreamSocketDataReceived(data);
    }

    checkForEnd(): void {
        const wasEnded = this.hasEnded;
        super.checkForEnd();
        if (!wasEnded && this.hasEnded && this.isWebSocket && this.wsConnectedTime > 0) {
            const duration = Date.now() - this.wsConnectedTime;
            const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
            console.log(`[${ts}] WS#${this.id} disconnected (${duration}ms)`);
        }
    }


    /******************
     * HTTP REQUEST PROCESSING
     *****************/

    processInitialRequestData(data: Buffer): Buffer | null {
        this.queuedChunks.push(data);

        const fullBuffer = Buffer.concat(this.queuedChunks);
        const headerEndPosition = fullBuffer.indexOf('\r\n\r\n');
        if (headerEndPosition < 0) return null;

        this.isRequestInFlight = true;
        this.queuedChunks = [];

        const absoluteHeaderEndPosition = headerEndPosition + 4;
        const headerBuffer = fullBuffer.subarray(0, absoluteHeaderEndPosition);

        const shouldContinue = this.processHeaders(headerBuffer);

        // if we've been told not to continue, it's because we didn't understand the request, so we're just
        // going to switch into flow mode and stop trying to interpret the conversation
        if (!shouldContinue) {
            this.disableInspection('did not understand headers');
            return fullBuffer;
        }

        // if there's no more data left
        if (fullBuffer.length === absoluteHeaderEndPosition) {
            // if this request is keep-alive, the request isn't chunked, and we're not expecting any more chunk bytes,
            // then the request must've been a simple one with no body, so we can consider it finished
            if (this.isInFlightRequestKeepAlive && !this.isInFlightRequestChunked && this.expectedChunkBytesRemaining === 0) {
                this.clearInFlightRequest();
            }

            return null;
        }

        const bodyBuffer = fullBuffer.subarray(absoluteHeaderEndPosition);
        return bodyBuffer;
    }

    processHeaders(headerBuffer: Buffer): boolean {
        let headerString = headerBuffer.toString('utf8');

        const requestLine = headerString.match(/^([A-Z]+) ([^ ]+) HTTP\/.+/);
        if (!requestLine) return false;

        const method = requestLine[1];
        const url = requestLine[2];
        this.log(method, url);
        this.pendingRequestLog = method + ' ' + url;
        this.pendingRequestTime = Date.now();

        if (this.client.options.rewriteHost) {
            const hostMatch = headerString.match(/^host: .*$/mi);
            if (!hostMatch) return false;

            headerString = headerString.substring(0, hostMatch.index! + 6) + this.client.options.rewriteHost + headerString.substring(hostMatch.index! + hostMatch[0].length);
        }

        const connectionMatch = headerString.match(/^connection: .*$/mi);
        if (connectionMatch) {
            if (connectionMatch[0].toLowerCase().includes('upgrade')) {
                this.log('connection upgrade detected. switching to flow mode.');
                this.isWebSocket = true;
                super.forwardUpstream(Buffer.from(headerString));
                this.isInspectionEnabled = false;
                return true;
            }
            this.isInFlightRequestKeepAlive = connectionMatch[0].includes('keep-alive');
            this.log('connection header:', connectionMatch[0]);
        } else {
            this.isInFlightRequestKeepAlive = true;
            this.log('no connection header specified. assuming keep-alive.');
        }

        if (this.isInFlightRequestKeepAlive) {
            const transferEncodingMatch = headerString.match(/^transfer-encoding: (.*)$/mi);
            if (transferEncodingMatch) {
                this.log('chunked transfer encoding enabled');
                this.isInFlightRequestChunked = transferEncodingMatch[0].includes('chunked');
            }

            if (!this.isInFlightRequestChunked) {
                const contentLengthMatch = headerString.match(/^content-length: ([0-9]+)$/mi);
                if (contentLengthMatch) {
                    this.expectedChunkBytesRemaining = parseInt(contentLengthMatch[1]);
                    this.log('expecting ' + this.expectedChunkBytesRemaining + ' bytes');
                } else {
                    this.log('no content length specified');
                }
            }
        }

        super.forwardUpstream(Buffer.from(headerString));

        return true;
    }

    processDataForKARequest(data: Buffer): void {
        super.forwardUpstream(data);

        if (this.isInFlightRequestChunked)
            this.processChunkedDataForKARequest(data);
        else
            this.processNonchunkedDataForKARequest(data);
    }

    processChunkedDataForKARequest(data: Buffer): void {
        if (this.expectedChunkBytesRemaining === 0) {
            const crLfPosition = data.indexOf('\r\n');
            if (crLfPosition < 0) return this.disableInspection('chunked content did not contained expected header segment');

            const headerSegment = data.subarray(0, crLfPosition).toString('utf8');
            const headerSegmentComponents = headerSegment.match(/^([0-9a-fA-F]+)($|;)/);
            if (!headerSegmentComponents) return this.disableInspection('chunked content header segment did not match expected format');

            this.expectedChunkBytesRemaining = parseInt(headerSegmentComponents[1], 16);

            // if the expect chunk bytes remaining is still 0, then this is the end of the data.
            // make sure we have two CRLFs and reset us for the next request
            // NOTE: we may have to improve this later if HTTP trailers w/ TCP segmentation are breaking the detection of the true end
            if (this.expectedChunkBytesRemaining === 0) {
                const doubleCrLfPosition = data.indexOf('\r\n\r\n');
                if (doubleCrLfPosition < 0) return this.disableInspection('chunked content end signal (0 len) did not contain expected double CRLF');
                if (data.length > doubleCrLfPosition + 4) return this.disableInspection('chunked content end signal (0 len) contains data after double CRLF');
                return this.clearInFlightRequest();
            }

            data = data.subarray(crLfPosition + 2);
        }

        if (data.length < this.expectedChunkBytesRemaining) {
            this.expectedChunkBytesRemaining -= data.length;
            return;
        }

        const dataAfterChunk = data.subarray(this.expectedChunkBytesRemaining);
        if (dataAfterChunk[0] !== 13 /*CR*/ || dataAfterChunk[1] !== 10 /*LF*/)
            return this.disableInspection('chunked content segment does not end with expected CRLF');

        this.expectedChunkBytesRemaining = 0;

        // if there's nothing after the CRLF, we're done here
        if (dataAfterChunk.length === 2)
            return;

        this.processChunkedDataForKARequest(dataAfterChunk.subarray(2));
    }

    processNonchunkedDataForKARequest(data: Buffer): void {
        this.expectedChunkBytesRemaining -= data.length;

        if (this.expectedChunkBytesRemaining < 0)
            return this.disableInspection('data size exceeded content length expectation');

        if (this.expectedChunkBytesRemaining === 0)
            this.clearInFlightRequest();
    }

    clearInFlightRequest(): void {
        this.isRequestInFlight = false;
        this.isInFlightRequestKeepAlive = false;
        this.isInFlightRequestChunked = false;
        this.expectedChunkBytesRemaining = 0;
        this.log('request segment ended');
    }

    disableInspection(reason: string): void {
        this.log(reason + '. switching into flowing mode.');
        this.isInspectionEnabled = false;
    }
}
