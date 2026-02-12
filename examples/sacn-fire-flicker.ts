import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];

const rand = (min: number, max: number): number => Math.floor(min + Math.random() * (max - min + 1));

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const heat = rand(150, 255);
        const cool = rand(0, 30);
        const flicker = rand(-30, 20);
        const white = rand(40, 160);

        universe.setChannel(1, Math.max(0, Math.min(255, heat + flicker)));
        universe.setChannel(2, Math.max(0, Math.min(255, Math.floor(heat * 0.35) + flicker)));
        universe.setChannel(3, cool);
        universe.setChannel(4, white);
        universe.setChannel(5, Math.max(0, white - rand(0, 40)));
    }

    await controller.flush();
}, 65);
