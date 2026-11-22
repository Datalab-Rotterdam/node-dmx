/**
 * Art-Net 4 utility helpers.
 * @module artnet/util
 *
 * Spec reference:
 * - Art-Net 4 Specification (Port-Address / Net/SubUni packing)
 *   https://art-net.org.uk/downloads/art-net.pdf
 */
import {networkInterfaces} from 'os';

export type ArtNetAddress = {
    /** 7-bit Net field (high universe bits). */
    net: number;
    /** 4-bit Sub-Net field. */
    subNet: number;
    /** 4-bit Universe field (0-15 inside one Sub-Net). */
    universe: number;
    /** Packed SubUni byte (`subNet << 4 | universe`). */
    subUni: number;
};

/**
 * Split a 1-based Art-Net universe number into Net/Sub-Net/Universe fields.
 * @param universe Universe index in range 1-32768.
 */
export const splitUniverseAddress = (universe: number): ArtNetAddress => {
    if (!Number.isInteger(universe) || universe < 1 || universe > 32768) {
        throw new RangeError(`Art-Net universe must be 1-32768, got ${universe}`);
    }
    return splitPortAddress(universe - 1);
};

/**
 * Split a raw 15-bit Art-Net Port-Address (0-32767, as shown by most Art-Net
 * consoles and nodes) into Net/Sub-Net/Universe fields.
 * @param portAddress Port-Address in range 0-32767.
 */
export const splitPortAddress = (portAddress: number): ArtNetAddress => {
    if (!Number.isInteger(portAddress) || portAddress < 0 || portAddress > 0x7fff) {
        throw new RangeError(`Art-Net Port-Address must be 0-32767, got ${portAddress}`);
    }
    const net = (portAddress >> 8) & 0x7f;
    const subNet = (portAddress >> 4) & 0x0f;
    const uni = portAddress & 0x0f;
    const subUni = (subNet << 4) | uni;
    return {net, subNet, universe: uni, subUni};
};

/** Convert a raw Port-Address (0-32767) into the library's 1-based universe number. */
export const portAddressToUniverse = (portAddress: number): number => {
    splitPortAddress(portAddress);
    return portAddress + 1;
};

/** Convert the library's 1-based universe number into a raw Port-Address (0-32767). */
export const universeToPortAddress = (universe: number): number => {
    splitUniverseAddress(universe);
    return universe - 1;
};

/**
 * Compute the directed (subnet) broadcast address for a local IPv4 address,
 * e.g. `192.168.1.20/24` → `192.168.1.255`. Art-Net recommends directed
 * broadcast over `255.255.255.255`, which most OSes only send out of the
 * default interface.
 * @param localAddress IPv4 address assigned to a local interface.
 * @returns Broadcast address, or `undefined` if the address isn't local.
 */
export const directedBroadcastAddress = (localAddress: string): string | undefined => {
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.address !== localAddress) continue;
            const ip = entry.address.split('.').map(Number);
            const mask = entry.netmask.split('.').map(Number);
            return ip.map((octet, i) => (octet | (~mask[i]! & 0xff)) & 0xff).join('.');
        }
    }
    return undefined;
};

/**
 * Read an ASCII string field that may contain NUL padding.
 * @param buffer Source buffer.
 * @param offset Field start offset.
 * @param length Maximum field length.
 */
export const readNullTerminatedString = (buffer: Buffer, offset: number, length: number): string => {
    const end = buffer.indexOf(0, offset);
    const limit = end === -1 ? offset + length : Math.min(end, offset + length);
    return buffer.toString('ascii', offset, limit).trim();
};
