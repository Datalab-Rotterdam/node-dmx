import {LlrpManager, uidToString} from '../src';

/**
 * Discovers real LLRP Targets on the local network segment via UDP
 * multicast (ANSI E1.33 §6) — no Broker connection required.
 *
 * Run: npm run example/rdmnet-llrp-discover
 */
async function main(): Promise<void> {
    const manager = new LlrpManager();
    await manager.start();

    console.log('Probing full UID range for LLRP Targets (this repeats until 3 clean rounds)...');
    const targets = await manager.discoverTargets();

    console.log(`Found ${targets.length} LLRP Target(s):`);
    for (const target of targets) {
        console.log(
            `  uid=${uidToString(target.uid)} mac=${target.hardwareAddress.toString('hex')} componentType=${target.componentType}`,
        );
    }

    manager.close();
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
