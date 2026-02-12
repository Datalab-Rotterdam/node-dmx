import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];

let t = 0;

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const o = u * 0.9;
        const g = Math.floor(40 + 150 * ((Math.sin(t * 0.70 + o) + 1) / 2));
        const b = Math.floor(60 + 180 * ((Math.sin(t * 0.52 + o + 1.2) + 1) / 2));
        const w1 = Math.floor(10 + 110 * ((Math.sin(t * 0.40 + o + 2.1) + 1) / 2));
        const w2 = Math.floor(10 + 90 * ((Math.sin(t * 0.33 + o + 2.8) + 1) / 2));

        universe.setChannel(1, 0);
        universe.setChannel(2, g);
        universe.setChannel(3, b);
        universe.setChannel(4, w1);
        universe.setChannel(5, w2);
    }

    await controller.flush();
    t += 0.06;
}, 35);
