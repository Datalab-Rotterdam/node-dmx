/**
 * Low-level implementation of the E1.31 (sACN) protocol.
 */

import assert from 'assert';
/**
 * sACN (E1.31) packet builder/parser.
 * @module sacn/packet
 */
import {type Payload, inRange, objectify} from './util';
import {
    ACN_PID,
    DEFAULT_CID,
    DmpVector,
    FrameOptions,
    FrameVector,
    RootVector,
} from './constants';

/**
 * Encode a source name into the 64-octet, NUL-terminated UTF-8 field used by
 * E1.31 data and discovery packets. Truncates to 63 bytes on a character
 * boundary so the terminator always fits.
 */
export const encodeSourceName = (name: string | undefined): Buffer => {
    const field = Buffer.alloc(64, 0);
    if (!name) return field;
    let bytes = Buffer.from(name, 'utf8');
    if (bytes.length > 63) {
        let end = 63;
        // Step back over UTF-8 continuation bytes (10xxxxxx) so we don't split a character.
        while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
        bytes = bytes.subarray(0, end);
    }
    bytes.copy(field);
    return field;
};

export interface Options {
    /** Universe number (1-63999). */
    universe: number;
    /** Channel payload as sparse object or raw DMX bytes. */
    payload: Payload | Buffer | Uint8Array;
    /** E1.31 sequence byte (0-255). */
    sequence: number;
    /** Source name (max 64 ASCII chars in wire format). */
    sourceName?: string;
    /** E1.31 priority value (0-200, typical default 100). */
    priority?: number;
    /** 16-byte CID UUID-like identifier. */
    cid?: Buffer;
    /** If true, treat payload values as 0-255 raw DMX instead of 0-100%. */
    useRawDmxValues?: boolean;
    /** Framing layer Options bitfield (see {@link FrameOptions}). */
    options?: number;
    /**
     * Synchronization Address (E1.31 §6): the universe number of a
     * Synchronization Packet receivers should wait for before applying this
     * frame. `0` (default) means "no synchronization requested".
     */
    syncUniverse?: number;
}

/**
 * Parsed or encoded sACN packet model.
 *
 * Construct with:
 * - `Buffer` to parse a received packet
 * - `Options` to build a sendable packet
 */
export class Packet {
    // Root Layer
    private readonly rootVector = RootVector.DATA;
    private rootFl: number = 0;
    private readonly preambleSize = 0x0010;
    private readonly postambleSize = 0;
    private readonly acnPid = ACN_PID;
    /** Component Identifier (CID) from root layer. */
    public cid: Buffer = Buffer.alloc(16);

    // Framing Layer
    private readonly frameVector = FrameVector.DATA;
    private frameFl: number = 0;
    /** Framing options byte. */
    public options = 0;
    /** Packet sequence number (0-255). */
    public sequence: number = 0;
    /** Source name from framing layer. */
    public sourceName: string = '';
    /** Packet priority (default 100). */
    public priority: number = 100;
    /** Synchronization universe (usually 0). */
    public syncUniverse = 0;
    /** Universe number for payload. */
    public universe: number = 1;

    // DMP Layer
    private readonly dmpVector = DmpVector.DATA;
    private dmpFl: number = 0;
    private readonly type = 0xa1;
    private readonly firstAddress = 0;
    private readonly addressIncrement = 1;
    public propertyValueCount = 0x0201; // 1 + 512
    /**
     * DMX512-A START Code. `0x00` is ordinary dimmer data; other values carry
     * alternate data (e.g. `0xDD` per-address priority). Receivers should only
     * treat `0x00` frames as levels.
     */
    public startCode = 0;
    private payloadInput: Buffer | Payload = {};

    private useRawDmxValues: boolean = false;

    /**
     * Parse or build an sACN packet.
     * @param input Raw buffer to parse, or packet options to encode.
     * @param sourceAddress Optional sender address when parsing.
     */
    constructor(
        input: Buffer | Options,
        public readonly sourceAddress?: string,
    ) {
        if (!input) {
            throw new Error('Packet instantiated with no input');
        }

        if (Buffer.isBuffer(input)) {
            this.parseFromBuffer(input);
        } else {
            this.createFromOptions(input as Options);
        }
    }

    private parseFromBuffer(buf: Buffer): void {
        // Validate minimum length
        if (buf.length < 126) {
            throw new RangeError('Buffer too short for sACN packet');
        }

        // Root Layer
        assert.strictEqual(buf.readUInt16BE(0), this.preambleSize);
        assert.strictEqual(buf.readUInt16BE(2), this.postambleSize);
        assert.ok(buf.subarray(4, 16).equals(this.acnPid), 'Invalid ACN packet identifier');
        this.rootFl = buf.readUInt16BE(16);
        assert.strictEqual(buf.readUInt32BE(18), this.rootVector);
        this.cid = Buffer.from(buf.subarray(22, 38)); // copy to avoid shared memory

        // Framing Layer
        this.frameFl = buf.readUInt16BE(38);
        assert.strictEqual(buf.readUInt32BE(40), this.frameVector);
        // Source name: 64-octet, NUL-terminated UTF-8 (E1.31 §6.2.2).
        const nameEnd = buf.indexOf(0, 44);
        this.sourceName = buf.toString('utf8', 44, nameEnd === -1 || nameEnd > 108 ? 108 : nameEnd);
        this.priority = buf.readUInt8(108);
        this.syncUniverse = buf.readUInt16BE(109);
        this.sequence = buf.readUInt8(111);
        this.options = buf.readUInt8(112);
        this.universe = buf.readUInt16BE(113);

        // DMP Layer
        this.dmpFl = buf.readUInt16BE(115);
        assert.strictEqual(buf.readUInt8(117), this.dmpVector);
        assert.strictEqual(buf.readUInt8(118), this.type);
        assert.strictEqual(buf.readUInt16BE(119), this.firstAddress);
        assert.strictEqual(buf.readUInt16BE(121), this.addressIncrement);
        this.propertyValueCount = buf.readUInt16BE(123);
        assert.ok(
            this.propertyValueCount >= 1 && this.propertyValueCount <= 513,
            `Invalid property value count ${this.propertyValueCount}`,
        );
        assert.ok(
            buf.length >= 125 + this.propertyValueCount,
            `Packet truncated: property value count ${this.propertyValueCount} needs ` +
                `${125 + this.propertyValueCount} bytes, got ${buf.length}`,
        );
        this.startCode = buf.readUInt8(125);

        // Copy payload (exactly propertyValueCount - 1 slots) to ensure independence
        this.payloadInput = Buffer.from(buf.subarray(126, 125 + this.propertyValueCount));
        this.useRawDmxValues = false;
    }

    /** `true` when the Preview_Data option bit is set (visualisation only, not for live output). */
    public get isPreview(): boolean {
        return (this.options & FrameOptions.PREVIEW_DATA) !== 0;
    }

    /** `true` when the Stream_Terminated option bit is set (source is stopping this universe). */
    public get isTerminated(): boolean {
        return (this.options & FrameOptions.STREAM_TERMINATED) !== 0;
    }

    /** `true` when the Force_Synchronization option bit is set. */
    public get forceSynchronization(): boolean {
        return (this.options & FrameOptions.FORCE_SYNCHRONIZATION) !== 0;
    }

    private createFromOptions(options: Options): void {
        this.rootFl = 0x726e;
        this.frameFl = 0x7258;
        this.dmpFl = 0x720b;

        if (!Number.isInteger(options.universe) || options.universe < 1 || options.universe > 63999) {
            throw new RangeError(`Universe must be 1-63999, got ${options.universe}`);
        }

        if (Buffer.isBuffer(options.payload) || options.payload instanceof Uint8Array) {
            this.payloadInput = Buffer.from(options.payload);
            this.useRawDmxValues = options.useRawDmxValues ?? true;
        } else {
            this.payloadInput = options.payload;
            this.useRawDmxValues = options.useRawDmxValues ?? false;
        }
        this.sourceName = options.sourceName || 'sACN nodejs';
        const priority = options.priority ?? 100;
        if (!Number.isInteger(priority) || priority < 0 || priority > 200) {
            throw new RangeError(`Priority must be an integer 0-200, got ${priority}`);
        }
        this.priority = priority;
        this.sequence = options.sequence & 0xff;
        this.universe = options.universe;
        this.options = options.options ?? 0;
        this.syncUniverse = options.syncUniverse ?? 0;
        this.cid = options.cid ? Buffer.from(options.cid) : DEFAULT_CID; // ensure copy
    }

    /**
     * Payload in sparse object form (channel => percentage value).
     * If the source was raw bytes, values are converted from 0-255 to 0-100%.
     */
    public get payload(): Payload {
        return Buffer.isBuffer(this.payloadInput)
            ? objectify(this.payloadInput)
            : {...this.payloadInput}; // defensive copy
    }

    /** Raw payload buffer when packet originated from raw bytes, else `null`. */
    public get payloadAsBuffer(): Buffer | null {
        return Buffer.isBuffer(this.payloadInput) ? this.payloadInput : null;
    }

    /** Fully encoded E1.31 packet bytes ready to send over UDP. */
    public get buffer(): Buffer {
        const sourceNameBuf = encodeSourceName(this.sourceName);

        const dmxData = Buffer.alloc(512, 0);

        if (Buffer.isBuffer(this.payloadInput)) {
            const length = Math.min(this.payloadInput.length, 512);
            for (let i = 0; i < length; i++) {
                dmxData[i] = inRange(this.payloadInput[i]);
            }
        } else {
            const payload = this.payload;
            for (const chStr in payload) {
                const ch = Number(chStr);
                if (Number.isInteger(ch) && ch >= 1 && ch <= 512) {
                    const value = payload[ch]!;
                    const scaled = this.useRawDmxValues
                        ? inRange(value)
                        : inRange(Math.round(value * 2.55));
                    dmxData[ch - 1] = scaled;
                }
            }
        }

        const header = Buffer.alloc(126);

        // Root Layer
        header.writeUInt16BE(this.preambleSize, 0);
        header.writeUInt16BE(this.postambleSize, 2);
        this.acnPid.copy(header, 4);
        header.writeUInt16BE(this.rootFl, 16);
        header.writeUInt32BE(this.rootVector, 18);
        this.cid.copy(header, 22);

        // Framing Layer
        header.writeUInt16BE(this.frameFl, 38);
        header.writeUInt32BE(this.frameVector, 40);
        sourceNameBuf.copy(header, 44);
        header.writeUInt8(this.priority, 108);
        header.writeUInt16BE(this.syncUniverse, 109);
        header.writeUInt8(this.sequence, 111);
        header.writeUInt8(this.options, 112);
        header.writeUInt16BE(this.universe, 113);

        // DMP Layer
        header.writeUInt16BE(this.dmpFl, 115);
        header.writeUInt8(this.dmpVector, 117);
        header.writeUInt8(this.type, 118);
        header.writeUInt16BE(this.firstAddress, 119);
        header.writeUInt16BE(this.addressIncrement, 121);
        header.writeUInt16BE(this.propertyValueCount, 123);
        header.writeUInt8(this.startCode, 125);

        return Buffer.concat([header, dmxData]);
    }
}
