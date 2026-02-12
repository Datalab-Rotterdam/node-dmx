import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];

let t = 0;
const sparkle = [0, 0, 0, 0];

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const phase = t + u * 0.85;
        const wave = (Math.sin(phase) + 1) / 2;

        const red = Math.floor(90 + 165 * wave);
        const green = Math.floor(90 + 165 * (1 - wave));

        sparkle[u] = Math.max(0, sparkle[u] - 30);
        if (Math.random() < 0.08) sparkle[u] = 255;

        universe.setChannel(1, red);
        universe.setChannel(2, green);
        universe.setChannel(3, 0);
        universe.setChannel(4, sparkle[u]);
        universe.setChannel(5, Math.max(0, sparkle[u] - 25));
    }

    await controller.flush();
    t += 0.14;
}, 45);
