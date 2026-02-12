import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];

let t = 0;
const lightning = [0, 0, 0, 0];

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const phase = t + u * 0.9;

        const orangePulse = (Math.sin(phase * 0.22) + 1) / 2;
        const purplePulse = (Math.sin(phase * 0.31 + 2.2) + 1) / 2;
        const ember = Math.random() * 18;

        lightning[u] = Math.max(0, lightning[u] - 40);
        if (Math.random() < 0.025) lightning[u] = 255;

        const r = Math.min(255, Math.floor(130 + 120 * orangePulse + ember));
        const g = Math.min(255, Math.floor(30 + 80 * orangePulse));
        const b = Math.min(255, Math.floor(35 + 140 * purplePulse));
        const w1 = Math.min(255, Math.floor(8 + 30 * orangePulse + lightning[u]));
        const w2 = Math.min(255, Math.floor(4 + 16 * purplePulse + lightning[u] * 0.7));

        universe.setChannel(1, r);
        universe.setChannel(2, g);
        universe.setChannel(3, b);
        universe.setChannel(4, w1);
        universe.setChannel(5, w2);
    }

    await controller.flush();
    t += 0.14;
}, 45);
