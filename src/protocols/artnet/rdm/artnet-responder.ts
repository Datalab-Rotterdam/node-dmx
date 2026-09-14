/**
 * Art-Net device/responder — lets a program simulate a real Art-Net
 * fixture: it receives ArtDMX for one universe, answers ArtPoll with an
 * ArtPollReply (so `ArtNetDiscovery` finds it), and answers ArtTodRequest/
 * ArtTodControl/ArtRdm using an {@link RdmResponder} — no manual Art-Net
 * framing or RDM frame building required.
 * @module artnet/rdm/artnet-responder
 */
import {createSocket, type Socket} from 'dgram';
import {EventEmitter} from 'events';

import {ARTNET_ID, ARTNET_PORT, OpCode} from '../constants';
import {buildArtPollReply, parseArtDmx, parseArtPoll} from '../packet';
import {splitUniverseAddress} from '../util';
import {buildArtRdm, buildArtTodData, parseArtRdm, parseArtTodControl, parseArtTodRequest} from './artnet-packets';
import type {RdmResponder} from './responder';

export type ArtNetRdmResponderOptions = {
    /** RDM/DMX responder logic; its UID is reported in ArtTodData. */
    responder: RdmResponder;
    /** 1-based universe this fixture listens/answers on. */
    universe: number;
    /** IPv4 address advertised in ArtPollReply. Defaults to `bindAddress` or `0.0.0.0`. */
    ip?: string;
    /** Local interface to bind to. */
    bindAddress?: string;
    /** UDP port (default 6454). */
    port?: number;
    /** Allow multiple listeners/senders on same UDP port. */
    reuseAddr?: boolean;
    /** Advertised in ArtPollReply (max 17 ASCII chars). */
    shortName?: string;
    /** Advertised in ArtPollReply (max 63 ASCII chars). */
    longName?: string;
};

export interface ArtNetRdmResponderEvents {
    /** Emitted whenever a new ArtDMX frame for our universe arrives. */
    dmx: [frame: Uint8Array];
    /** Emitted after answering an RDM command (whatever the responder returned, ACK or NACK). */
    rdm: [replied: boolean];
    error: [error: Error];
}

/** Simulates one Art-Net-discoverable, RDM-capable fixture. */
export class ArtNetRdmResponder extends EventEmitter<ArtNetRdmResponderEvents> {
    private readonly socket: Socket;
    private readonly options: Required<Pick<ArtNetRdmResponderOptions, 'universe' | 'port'>> & ArtNetRdmResponderOptions;
    private readonly frame = new Uint8Array(512);

    constructor(options: ArtNetRdmResponderOptions) {
        super();
        this.options = {port: ARTNET_PORT, ...options};

        this.socket = createSocket({type: 'udp4', reuseAddr: options.reuseAddr ?? false});
        this.socket.on('message', (msg, rinfo) => {
            try {
                this.handleMessage(msg, rinfo);
            } catch (err) {
                this.emit('error', err as Error);
            }
        });
        this.socket.on('error', (err) => this.emit('error', err));
        this.socket.bind({port: this.options.port, address: options.bindAddress ?? '0.0.0.0'});
    }

    /** Current DMX levels received for our universe (index 0 = channel 1). */
    public getDmxFrame(): Uint8Array {
        return this.frame;
    }

    /** The RDM responder driving this fixture's RDM answers. */
    public get rdmResponder(): RdmResponder {
        return this.options.responder;
    }

    public close(callback?: () => void): void {
        this.socket.close(callback);
    }

    private handleMessage(msg: Buffer, rinfo: {address: string; port: number}): void {
        if (msg.length < 10 || msg.toString('ascii', 0, 8) !== ARTNET_ID) return;

        if (parseArtPoll(msg)) {
            this.replyPoll(rinfo);
            return;
        }

        const dmx = parseArtDmx(msg);
        if (dmx) {
            if (dmx.universe === this.options.universe) {
                this.frame.set(dmx.data.subarray(0, 512));
                this.emit('dmx', this.frame);
            }
            return;
        }

        const opcode = msg.readUInt16LE(8);
        if (opcode === OpCode.OpTodRequest) {
            const request = parseArtTodRequest(msg);
            if (request && this.wantsOurUniverse(request.addCount, request.addresses)) {
                this.replyTod(rinfo);
            }
            return;
        }

        if (opcode === OpCode.OpTodControl) {
            if (parseArtTodControl(msg)) this.replyTod(rinfo);
            return;
        }

        if (opcode === OpCode.OpRdm) {
            const request = parseArtRdm(msg);
            if (!request) return;
            const replyFrame = this.options.responder.respond(request.rdmPacket);
            if (replyFrame) {
                const packet = buildArtRdm({universe: this.options.universe, rdmPacket: replyFrame.subarray(1)});
                this.send(packet, rinfo);
            }
            this.emit('rdm', replyFrame !== null);
        }
    }

    private wantsOurUniverse(addCount: number, addresses: number[]): boolean {
        if (addCount === 0) return true;
        const {subUni} = splitUniverseAddress(this.options.universe);
        return addresses.includes(subUni);
    }

    private replyPoll(rinfo: {address: string; port: number}): void {
        const packet = buildArtPollReply({
            ip: this.options.ip ?? this.options.bindAddress ?? '0.0.0.0',
            port: this.options.port,
            universe: this.options.universe,
            shortName: this.options.shortName,
            longName: this.options.longName,
            estaManufacturer: this.options.responder.uid.manufacturerId,
        });
        this.send(packet, rinfo);
    }

    private replyTod(rinfo: {address: string; port: number}): void {
        const packet = buildArtTodData({universe: this.options.universe, uids: [this.options.responder.uid]});
        this.send(packet, rinfo);
    }

    private send(packet: Buffer, rinfo: {address: string; port: number}): void {
        this.socket.send(packet, rinfo.port, rinfo.address, (err) => {
            if (err) this.emit('error', err);
        });
    }
}
