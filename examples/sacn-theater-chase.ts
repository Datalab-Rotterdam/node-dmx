import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];
const channels = [1, 2, 3, 4, 5];

let step = 0;

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];

        for (let c = 0; c < channels.length; c += 1) {
            const on = ((c + step + u) % 3) === 0;
            universe.setChannel(channels[c], on ? 230 : 0);
        }
    }

    await controller.flush();
    step = (step + 1) % 3;
}, 110);
