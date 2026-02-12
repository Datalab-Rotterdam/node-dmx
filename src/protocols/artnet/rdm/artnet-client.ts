/**
 * Art-Net RDM client (OpRdm / OpTodRequest / OpTodData).
 * @module artnet/rdm/artnet-client
 *
 * Spec references:
 * - Art-Net 4 Specification (RDM over Art-Net transport)
 *   https://art-net.org.uk/downloads/art-net.pdf
 * - ANSI E1.20 (RDM framing)
 *   https://getdlight.com/media/kunena/attachments/42/ANSI_E1-20_2010.pdf
 */
import {createSocket, type Socket} from 'dgram';
import {ARTNET_PORT} from '../constants';
import {buildArtRdm, buildArtTodRequest, parseArtTodData} from './artnet-packets';
import {encodeRdmRequest, decodeRdmResponse} from './codec';
import type {RdmRequest, RdmResponse} from './types';
import type {UID} from './uid';

export type ArtNetRdmClientOptions = {
    /** Target Art-Net node IP/hostname. */
    host: string;
    /** Optional local bind address. */
    bindAddress?: string;
    /** UDP destination port (defaults to Art-Net 6454). */
    port?: number;
    /** Default receive timeout in milliseconds. */
    timeoutMs?: number;
};

/** Minimal client for ToD and single-request RDM transactions over Art-Net. */
export class ArtNetRdmClient {
    private readonly socket: Socket;
    private readonly options: ArtNetRdmClientOptions;

    /**
     * Create an Art-Net RDM client.
     * @param options Socket and timeout options.
     */
    constructor(options: ArtNetRdmClientOptions) {
        this.options = options;
        this.socket = createSocket('udp4');
        if (options.bindAddress) {
            this.socket.bind({address: options.bindAddress});
        }
    }

    /**
     * Request the Table of Devices (ToD) for a universe.
     */
    public async getTod(universe: number, timeoutMs?: number): Promise<UID[]> {
        const packet = buildArtTodRequest({universe});
        const replies = await this.collectResponses(packet, timeoutMs);
        const uids: UID[] = [];
        for (const response of replies) {
            const tod = parseArtTodData(response);
            if (tod) {
                uids.push(...tod.uids);
            }
        }
        return uids;
    }

    /**
     * Send a single RDM request and wait for a response.
     */
    public async rdmTransaction(
        universe: number,
        request: RdmRequest,
        timeoutMs?: number,
    ): Promise<RdmResponse | null> {
        const rdmPacket = encodeRdmRequest(request);
        const packet = buildArtRdm({
            universe,
            rdmPacket: rdmPacket.subarray(1),
        });
        const replies = await this.collectResponses(packet, timeoutMs);
        for (const response of replies) {
            const rdm = this.extractRdm(response);
            if (rdm) return rdm;
        }
        return null;
    }

    /**
     * Close the UDP socket.
     */
    public close(): void {
        this.socket.close();
    }

    private async collectResponses(packet: Buffer, timeoutMs?: number): Promise<Buffer[]> {
        const replies: Buffer[] = [];
        const handler = (msg: Buffer) => replies.push(msg);
        this.socket.on('message', handler);
        await this.send(packet);
        const timeout = timeoutMs ?? this.options.timeoutMs ?? 1000;
        await new Promise((resolve) => setTimeout(resolve, timeout));
        this.socket.off('message', handler);
        return replies;
    }

    private async send(packet: Buffer): Promise<void> {
        const port = this.options.port ?? ARTNET_PORT;
        await new Promise<void>((resolve, reject) => {
            this.socket.send(packet, port, this.options.host, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    private extractRdm(buffer: Buffer): RdmResponse | null {
        if (buffer.length < 27) return null;
        const rdmPacket = buffer.subarray(26);
        const withStartCode = Buffer.concat([Buffer.from([0xcc]), rdmPacket]);
        try {
            return decodeRdmResponse(withStartCode);
        } catch {
            return null;
        }
    }
}
