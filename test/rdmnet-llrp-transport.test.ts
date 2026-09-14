import {afterEach, describe, expect, it} from 'vitest';

import {LlrpComponentType, LlrpManager, LlrpTarget, UID_MAX, UID_MIN} from '../src';

describe('LLRP UDP transport (loopback multicast)', () => {
    let manager: LlrpManager | undefined;
    let target: LlrpTarget | undefined;

    afterEach(() => {
        manager?.close();
        target?.close();
        manager = undefined;
        target = undefined;
    });

    it('discovers a real Target over UDP multicast via a Probe Request/Reply round', async () => {
        const targetUid = {manufacturerId: 0x7a70, deviceId: 0x00000042};
        target = new LlrpTarget({
            uid: targetUid,
            hardwareAddress: Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]),
            componentType: LlrpComponentType.RptDevice,
        });
        await target.start();

        manager = new LlrpManager();
        await manager.start();

        // A Target replies after a randomized 0-1500ms backoff (to reduce reply
        // collisions, per llrp_target.c) inside the Manager's 2000ms probe
        // window — a single round can legitimately come up empty by chance,
        // which is exactly why real discovery repeats a range until it sees
        // several clean rounds in a row. Retry a couple of rounds here rather
        // than asserting a single round always succeeds.
        let replies: Awaited<ReturnType<LlrpManager['probeOnce']>> = [];
        for (let attempt = 0; attempt < 3 && replies.length === 0; attempt++) {
            replies = await manager.probeOnce(UID_MIN, UID_MAX, []);
        }

        expect(replies).toHaveLength(1);
        expect(replies[0]!.uid).toEqual(targetUid);
        expect(replies[0]!.hardwareAddress).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]));
        expect(replies[0]!.componentType).toBe(LlrpComponentType.RptDevice);
    }, 15000);

    it('excludes a known UID from replying (used by the discovery exclusion list)', async () => {
        const targetUid = {manufacturerId: 0x7a70, deviceId: 0x00000099};
        target = new LlrpTarget({
            uid: targetUid,
            hardwareAddress: Buffer.from([0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]),
        });
        await target.start();

        manager = new LlrpManager();
        await manager.start();

        const replies = await manager.probeOnce(UID_MIN, UID_MAX, [targetUid]);
        expect(replies).toHaveLength(0);
    }, 10000);

    it('relays an RDM command/response pair between Manager and Target', async () => {
        const targetUid = {manufacturerId: 0x7a70, deviceId: 0x000000aa};
        const responseFrame = Buffer.from([0xcc, 0x01, 0x04, 0xde, 0xad, 0xbe, 0xef]);
        target = new LlrpTarget({
            uid: targetUid,
            hardwareAddress: Buffer.from([1, 1, 1, 1, 1, 1]),
            onRdmCommand: () => responseFrame,
        });
        await target.start();

        manager = new LlrpManager();
        await manager.start();

        const requestFrame = Buffer.from([0xcc, 0x01, 0x03, 0x11, 0x22, 0x33]);
        const transactionNumber = await manager.sendRdmCommand(target.getCid(), requestFrame);
        const response = await manager.waitForRdmResponse(transactionNumber, 1000);

        expect(response).toEqual(responseFrame);
    }, 10000);
});
