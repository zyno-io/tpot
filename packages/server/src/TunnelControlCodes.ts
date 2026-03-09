// control: 0x11 + 1 byte control command + data
// convo:   0x12 + 2 byte conversation ID + 1 byte control command + data

export const MSG_CONTROL = 0x11;
export const MSG_CONVO = 0x12;

export const CONTROL_GREETINGS = 'G'.charCodeAt(0);

export const TYPE_HTTP = 'H'.charCodeAt(0);
export const TYPE_RAW = 'R'.charCodeAt(0);

export const CONVO_DATA = 'D'.charCodeAt(0);
export const CONVO_PAUSE = 'P'.charCodeAt(0);
export const CONVO_RESUME = 'C'.charCodeAt(0);
export const CONVO_CLOSED = 'X'.charCodeAt(0);
export const CONVO_NOCONNECT = 'N'.charCodeAt(0);
