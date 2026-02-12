import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];
const channels = [1, 2, 3, 4, 5];
const tail = [255, 140, 70, 30, 10];

let frame = 0;

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const head = (frame + u) % channels.length;

        for (let c = 0; c < channels.length; c += 1) {
            const wrapDist = (head - c + channels.length) % channels.length;
            universe.setChannel(channels[c], tail[wrapDist] ?? 0);
        }
    }

    await controller.flush();
    frame = (frame + 1) % channels.length;
}, 90);
