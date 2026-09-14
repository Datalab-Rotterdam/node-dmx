/**
 * Transport-agnostic RDM responder core — lets a program act as an RDM
 * *device* (a simulated fixture) instead of a controller: it decodes an
 * incoming request, runs the standard PID set (DISC_MUTE/UN_MUTE,
 * SUPPORTED_PARAMETERS, DEVICE_INFO, DMX_START_ADDRESS, IDENTIFY_DEVICE,
 * DEVICE_LABEL, DMX_PERSONALITY(_DESCRIPTION), MANUFACTURER_LABEL,
 * DEVICE_MODEL_DESCRIPTION, SOFTWARE_VERSION_LABEL), and hands back a
 * ready-to-send response — no manual ACK/NACK frame or checksum handling.
 *
 * Two entry points cover every transport in this library:
 * - {@link RdmResponder.respond} takes/returns raw E1.20 frame bytes
 *   (Art-Net `ArtRdm`, LLRP RDM Command) — including the special
 *   DISC_UNIQUE_BRANCH discovery-response framing.
 * - {@link RdmResponder.handle} takes/returns already-decoded
 *   {@link RdmRequest}/{@link RdmResponse} objects (RDMnet RPT, which never
 *   carries line-level discovery unique-branch traffic).
 *
 * @module artnet/rdm/responder
 */
import {decodeRdmRequest, encodeRdmResponse} from './codec';
import {PIDS, RdmCommandClass, RdmNackReason, RdmResponseType, RDM_PROTOCOL_VERSION} from './constants';
import {encodeDiscoveryResponse} from './discovery';
import type {RdmRequest, RdmResponse} from './types';
import {uidCompare, uidFromBuffer, uidInRange, UID_MAX, type UID} from './uid';

export type RdmPersonality = {
    /** DMX channel count for this personality (1-512). */
    footprint: number;
    /** Human-readable description (max 32 ASCII chars). */
    description?: string;
};

export type RdmResponderOptions = {
    /** This device's RDM UID. */
    uid: UID;
    deviceModelId?: number;
    /** Product category code (ANSI E1.20 Table A-3). Defaults to a generic fixture code. */
    productCategory?: number;
    softwareVersionId?: number;
    softwareVersionLabel?: string;
    manufacturerLabel?: string;
    deviceModelDescription?: string;
    deviceLabel?: string;
    dmxStartAddress?: number;
    /** Available personalities (modes). Defaults to one personality matching `dmxFootprint`/1. */
    personalities?: RdmPersonality[];
    /** 1-based index into `personalities`. Defaults to 1. */
    currentPersonality?: number;
    /** Extra manufacturer-specific PIDs to advertise via SUPPORTED_PARAMETERS; handle them via `onUnhandledCommand`. */
    additionalSupportedPids?: number[];
    onIdentifyChange?: (identify: boolean) => void;
    onDmxStartAddressChange?: (address: number) => void;
    onDeviceLabelChange?: (label: string) => void;
    onPersonalityChange?: (personality: number, footprint: number) => void;
    /**
     * Called for any GET/SET this responder doesn't handle itself. Return
     * response parameter-data bytes to ACK, an {@link RdmNackReason} to
     * NACK, or `undefined` to fall back to NACK(UNKNOWN_PID) — no frame
     * building required either way.
     */
    onUnhandledCommand?: (request: RdmRequest) => Buffer | RdmNackReason | undefined;
};

const DEFAULT_SUPPORTED_PIDS = [
    PIDS.DEVICE_LABEL,
    PIDS.DEVICE_MODEL_DESCRIPTION,
    PIDS.MANUFACTURER_LABEL,
    PIDS.DMX_PERSONALITY,
    PIDS.DMX_PERSONALITY_DESCRIPTION,
];

function writeAsciiField(text: string, maxLength: number): Buffer {
    return Buffer.from(text.substring(0, maxLength), 'ascii');
}

/** Simulates one RDM-responding device. See module docs for the two entry points. */
export class RdmResponder {
    public readonly uid: UID;
    private readonly deviceModelId: number;
    private readonly productCategory: number;
    private readonly softwareVersionId: number;
    private readonly softwareVersionLabel: string;
    private readonly manufacturerLabel: string;
    private readonly deviceModelDescription: string;
    private readonly additionalSupportedPids: number[];
    private readonly onIdentifyChange?: RdmResponderOptions['onIdentifyChange'];
    private readonly onDmxStartAddressChange?: RdmResponderOptions['onDmxStartAddressChange'];
    private readonly onDeviceLabelChange?: RdmResponderOptions['onDeviceLabelChange'];
    private readonly onPersonalityChange?: RdmResponderOptions['onPersonalityChange'];
    private readonly onUnhandledCommand?: RdmResponderOptions['onUnhandledCommand'];

    private readonly personalities: RdmPersonality[];
    private _currentPersonality: number;
    private _dmxStartAddress: number;
    private _deviceLabel: string;
    private _identify = false;
    private _muted = false;

    constructor(options: RdmResponderOptions) {
        this.uid = options.uid;
        this.deviceModelId = options.deviceModelId ?? 0x0001;
        this.productCategory = options.productCategory ?? 0x0100; // "Fixture" (generic)
        this.softwareVersionId = options.softwareVersionId ?? 0x00000001;
        this.softwareVersionLabel = options.softwareVersionLabel ?? '1.0';
        this.manufacturerLabel = options.manufacturerLabel ?? 'node-dmx';
        this.deviceModelDescription = options.deviceModelDescription ?? 'node-dmx simulated fixture';
        this.additionalSupportedPids = options.additionalSupportedPids ?? [];
        this.onIdentifyChange = options.onIdentifyChange;
        this.onDmxStartAddressChange = options.onDmxStartAddressChange;
        this.onDeviceLabelChange = options.onDeviceLabelChange;
        this.onPersonalityChange = options.onPersonalityChange;
        this.onUnhandledCommand = options.onUnhandledCommand;

        this.personalities = options.personalities?.length ? options.personalities : [{footprint: 1}];
        this._currentPersonality = options.currentPersonality ?? 1;
        if (this._currentPersonality < 1 || this._currentPersonality > this.personalities.length) {
            throw new RangeError(`currentPersonality must be 1-${this.personalities.length}`);
        }
        this._dmxStartAddress = options.dmxStartAddress ?? 1;
        this._deviceLabel = options.deviceLabel ?? '';
    }

    public get muted(): boolean {
        return this._muted;
    }

    public get identify(): boolean {
        return this._identify;
    }

    public get deviceLabel(): string {
        return this._deviceLabel;
    }

    public get dmxStartAddress(): number {
        return this._dmxStartAddress;
    }

    public get currentPersonality(): number {
        return this._currentPersonality;
    }

    public get dmxFootprint(): number {
        return this.personalities[this._currentPersonality - 1]!.footprint;
    }

    /**
     * Raw-frame entry point: decode `requestFrame` (a full E1.20 frame
     * starting with 0xCC), run it through the responder, and return the
     * raw reply frame to send back — or `null` if nothing should be sent
     * (not addressed to us, muted, or a broadcast, all of which are silent
     * per RDM's rules). Use this for Art-Net (`ArtRdm`) and LLRP (RDM
     * Command) transports.
     */
    public respond(requestFrame: Buffer): Buffer | null {
        let request: RdmRequest;
        try {
            request = decodeRdmRequest(requestFrame);
        } catch {
            return null;
        }

        if (request.commandClass === RdmCommandClass.DISCOVERY_COMMAND && request.pid === PIDS.DISC_UNIQUE_BRANCH) {
            return this.handleDiscoveryUniqueBranch(request);
        }

        const response = this.handleDecoded(request);
        return response ? encodeRdmResponse(response) : null;
    }

    /**
     * Decoded-object entry point: same behavior as {@link respond} minus
     * line-level DISC_UNIQUE_BRANCH discovery (which has no meaning over a
     * message-based transport like RDMnet RPT — a real E1.33 controller
     * already knows your UID from the Broker's client list). Use this for
     * RDMnet.
     */
    public handle(request: RdmRequest): RdmResponse | null {
        if (request.commandClass === RdmCommandClass.DISCOVERY_COMMAND && request.pid === PIDS.DISC_UNIQUE_BRANCH) {
            return null;
        }
        return this.handleDecoded(request);
    }

    private handleDiscoveryUniqueBranch(request: RdmRequest): Buffer | null {
        if (this._muted) return null;
        const parameterData = request.parameterData ?? Buffer.alloc(0);
        if (parameterData.length < 12) return null;
        const lower = uidFromBuffer(parameterData, 0);
        const upper = uidFromBuffer(parameterData, 6);
        if (!uidInRange(this.uid, lower, upper)) return null;
        return encodeDiscoveryResponse(this.uid);
    }

    private handleDecoded(request: RdmRequest): RdmResponse | null {
        const isUnicast = uidCompare(request.destinationUid, this.uid) === 0;
        const isBroadcastAll = uidCompare(request.destinationUid, UID_MAX) === 0;
        const isManufacturerBroadcast =
            request.destinationUid.manufacturerId === this.uid.manufacturerId
            && request.destinationUid.deviceId === 0xffffffff;
        if (!isUnicast && !isBroadcastAll && !isManufacturerBroadcast) return null;

        const subDevice = request.subDevice ?? 0;
        if (subDevice !== 0 && subDevice !== 0xffff) {
            return isUnicast ? this.nack(request, RdmNackReason.SUB_DEVICE_OUT_OF_RANGE) : null;
        }

        let result: RdmResponse | 'unhandled';
        if (request.commandClass === RdmCommandClass.DISCOVERY_COMMAND) {
            result = this.handleDiscoveryCommand(request);
        } else if (request.commandClass === RdmCommandClass.GET_COMMAND || request.commandClass === RdmCommandClass.SET_COMMAND) {
            result = this.handleGetSet(request);
        } else {
            result = this.nack(request, RdmNackReason.UNSUPPORTED_COMMAND_CLASS);
        }

        if (result === 'unhandled') {
            result = this.nack(request, RdmNackReason.UNKNOWN_PID);
        }
        // Broadcasts (including manufacturer-broadcast) apply their effect
        // (already done above) but never get a reply, per RDM's rules.
        return isUnicast ? result : null;
    }

    private handleDiscoveryCommand(request: RdmRequest): RdmResponse | 'unhandled' {
        if (request.pid === PIDS.DISC_MUTE) {
            this._muted = true;
            return this.ack(request, Buffer.alloc(2));
        }
        if (request.pid === PIDS.DISC_UN_MUTE) {
            this._muted = false;
            return this.ack(request, Buffer.alloc(2));
        }
        return 'unhandled';
    }

    private handleGetSet(request: RdmRequest): RdmResponse | 'unhandled' {
        const isGet = request.commandClass === RdmCommandClass.GET_COMMAND;
        const parameterData = request.parameterData ?? Buffer.alloc(0);

        switch (request.pid) {
            case PIDS.SUPPORTED_PARAMETERS: {
                if (!isGet) return this.nack(request, RdmNackReason.UNSUPPORTED_COMMAND_CLASS);
                const pids = [...this.additionalSupportedPids, ...DEFAULT_SUPPORTED_PIDS];
                const data = Buffer.alloc(pids.length * 2);
                pids.forEach((pid, i) => data.writeUInt16BE(pid, i * 2));
                return this.ack(request, data);
            }
            case PIDS.DEVICE_INFO: {
                if (!isGet) return this.nack(request, RdmNackReason.UNSUPPORTED_COMMAND_CLASS);
                const data = Buffer.alloc(19);
                data.writeUInt16BE(RDM_PROTOCOL_VERSION, 0);
                data.writeUInt16BE(this.deviceModelId, 2);
                data.writeUInt16BE(this.productCategory, 4);
                data.writeUInt32BE(this.softwareVersionId, 6);
                data.writeUInt16BE(this.dmxFootprint, 10);
                data.writeUInt8(this._currentPersonality, 12);
                data.writeUInt8(this.personalities.length, 13);
                data.writeUInt16BE(this.dmxFootprint > 0 ? this._dmxStartAddress : 0xffff, 14);
                data.writeUInt16BE(0, 16); // sub-device count
                data.writeUInt8(0, 18); // sensor count
                return this.ack(request, data);
            }
            case PIDS.SOFTWARE_VERSION_LABEL:
                return isGet
                    ? this.ack(request, writeAsciiField(this.softwareVersionLabel, 32))
                    : this.nack(request, RdmNackReason.UNSUPPORTED_COMMAND_CLASS);
            case PIDS.MANUFACTURER_LABEL:
                return isGet
                    ? this.ack(request, writeAsciiField(this.manufacturerLabel, 32))
                    : this.nack(request, RdmNackReason.UNSUPPORTED_COMMAND_CLASS);
            case PIDS.DEVICE_MODEL_DESCRIPTION:
                return isGet
                    ? this.ack(request, writeAsciiField(this.deviceModelDescription, 32))
                    : this.nack(request, RdmNackReason.UNSUPPORTED_COMMAND_CLASS);
            case PIDS.DEVICE_LABEL:
                if (isGet) return this.ack(request, writeAsciiField(this._deviceLabel, 32));
                this._deviceLabel = parameterData.toString('ascii').substring(0, 32);
                this.onDeviceLabelChange?.(this._deviceLabel);
                return this.ack(request);
            case PIDS.DMX_START_ADDRESS: {
                if (isGet) {
                    const data = Buffer.alloc(2);
                    data.writeUInt16BE(this._dmxStartAddress, 0);
                    return this.ack(request, data);
                }
                if (parameterData.length !== 2) return this.nack(request, RdmNackReason.FORMAT_ERROR);
                const address = parameterData.readUInt16BE(0);
                if (address < 1 || address > 512) return this.nack(request, RdmNackReason.DATA_OUT_OF_RANGE);
                this._dmxStartAddress = address;
                this.onDmxStartAddressChange?.(address);
                return this.ack(request);
            }
            case PIDS.IDENTIFY_DEVICE: {
                if (isGet) return this.ack(request, Buffer.from([this._identify ? 1 : 0]));
                if (parameterData.length !== 1) return this.nack(request, RdmNackReason.FORMAT_ERROR);
                const value = parameterData.readUInt8(0);
                if (value !== 0 && value !== 1) return this.nack(request, RdmNackReason.DATA_OUT_OF_RANGE);
                this._identify = value === 1;
                this.onIdentifyChange?.(this._identify);
                return this.ack(request);
            }
            case PIDS.DMX_PERSONALITY: {
                if (isGet) {
                    return this.ack(request, Buffer.from([this._currentPersonality, this.personalities.length]));
                }
                if (parameterData.length !== 1) return this.nack(request, RdmNackReason.FORMAT_ERROR);
                const index = parameterData.readUInt8(0);
                if (index < 1 || index > this.personalities.length) return this.nack(request, RdmNackReason.DATA_OUT_OF_RANGE);
                this._currentPersonality = index;
                this.onPersonalityChange?.(index, this.dmxFootprint);
                return this.ack(request);
            }
            case PIDS.DMX_PERSONALITY_DESCRIPTION: {
                if (!isGet) return this.nack(request, RdmNackReason.UNSUPPORTED_COMMAND_CLASS);
                if (parameterData.length !== 1) return this.nack(request, RdmNackReason.FORMAT_ERROR);
                const index = parameterData.readUInt8(0);
                const personality = this.personalities[index - 1];
                if (!personality) return this.nack(request, RdmNackReason.DATA_OUT_OF_RANGE);
                const description = writeAsciiField(personality.description ?? `Mode ${index}`, 32);
                const data = Buffer.alloc(3 + description.length);
                data.writeUInt8(index, 0);
                data.writeUInt16BE(personality.footprint, 1);
                description.copy(data, 3);
                return this.ack(request, data);
            }
            default: {
                if (this.onUnhandledCommand) {
                    const result = this.onUnhandledCommand(request);
                    if (Buffer.isBuffer(result)) return this.ack(request, result);
                    if (typeof result === 'number') return this.nack(request, result);
                }
                return 'unhandled';
            }
        }
    }

    private responseCommandClass(requestClass: RdmCommandClass): RdmCommandClass {
        switch (requestClass) {
            case RdmCommandClass.GET_COMMAND:
                return RdmCommandClass.GET_COMMAND_RESPONSE;
            case RdmCommandClass.SET_COMMAND:
                return RdmCommandClass.SET_COMMAND_RESPONSE;
            default:
                return RdmCommandClass.DISCOVERY_COMMAND_RESPONSE;
        }
    }

    private ack(request: RdmRequest, parameterData: Buffer = Buffer.alloc(0)): RdmResponse {
        return {
            destinationUid: request.sourceUid,
            sourceUid: this.uid,
            transactionNumber: request.transactionNumber,
            responseType: RdmResponseType.ACK,
            messageCount: 0,
            subDevice: request.subDevice ?? 0,
            commandClass: this.responseCommandClass(request.commandClass),
            pid: request.pid,
            parameterData,
        };
    }

    private nack(request: RdmRequest, reason: RdmNackReason): RdmResponse {
        const parameterData = Buffer.alloc(2);
        parameterData.writeUInt16BE(reason, 0);
        return {
            destinationUid: request.sourceUid,
            sourceUid: this.uid,
            transactionNumber: request.transactionNumber,
            responseType: RdmResponseType.NACK_REASON,
            messageCount: 0,
            subDevice: request.subDevice ?? 0,
            commandClass: this.responseCommandClass(request.commandClass),
            pid: request.pid,
            parameterData,
        };
    }
}
