export class HttpError extends Error {
    statusCode: number;
    extendedMessage?: string;

    constructor(statusCode: number, message: string, extendedMessage?: string) {
        super(message);

        this.statusCode = statusCode;
        this.extendedMessage = extendedMessage;
    }
}

export class TunnelError extends Error {}
