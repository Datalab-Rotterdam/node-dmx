import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];

const lightning = [0, 0, 0, 0];

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];

        lightning[u] = Math.max(0, lightning[u] - 45);
        if (Math.random() < 0.04) lightning[u] = 255;
        if (Math.random() < 0.015) lightning[u] = 200;

        const rainBlue = 30 + Math.floor(Math.random() * 25);
        const rainWhite = 8 + Math.floor(Math.random() * 12);

        universe.setChannel(1, 0);
        universe.setChannel(2, 0);
        universe.setChannel(3, Math.min(255, rainBlue + Math.floor(lightning[u] * 0.35)));
        universe.setChannel(4, Math.min(255, rainWhite + lightning[u]));
        universe.setChannel(5, Math.min(255, rainWhite + Math.floor(lightning[u] * 0.8)));
    }

    await controller.flush();
}, 45);
