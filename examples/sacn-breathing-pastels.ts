import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];

let t = 0;

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const offset = u * 0.7;
        const breath = (Math.sin(t + offset) + 1) / 2;
        const r = 80 + Math.floor(100 * ((Math.sin(t * 0.7 + offset) + 1) / 2));
        const g = 80 + Math.floor(100 * ((Math.sin(t * 0.9 + offset + 2) + 1) / 2));
        const b = 80 + Math.floor(100 * ((Math.sin(t * 1.1 + offset + 4) + 1) / 2));
        const w = Math.floor(25 + 90 * breath);

        universe.setChannel(1, Math.min(255, r + 30));
        universe.setChannel(2, Math.min(255, g + 30));
        universe.setChannel(3, Math.min(255, b + 30));
        universe.setChannel(4, w);
        universe.setChannel(5, w);
    }

    await controller.flush();
    t += 0.08;
}, 35);
