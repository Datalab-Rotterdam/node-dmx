import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];
const channels = [1, 2, 3, 4, 5];
const totalSteps = universes.length * channels.length;

let progress = 0;
let direction = 1;

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        for (let c = 0; c < channels.length; c += 1) {
            const idx = u * channels.length + c;
            universes[u].setChannel(channels[c], idx <= progress ? 255 : 0);
        }
    }

    await controller.flush();

    progress += direction;
    if (progress >= totalSteps - 1) {
        progress = totalSteps - 1;
        direction = -1;
    } else if (progress <= 0) {
        progress = 0;
        direction = 1;
    }
}, 100);
