import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];

let tick = 0;

setInterval(async () => {
    const phase = tick % 16;
    const burstOn = phase < 6;
    const swap = phase >= 8;
    const strobe = phase === 1 || phase === 3 || phase === 9 || phase === 11;

    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const redSide = (u % 2 === 0) !== swap;

        universe.setChannel(1, burstOn && redSide ? 255 : 0);
        universe.setChannel(2, 0);
        universe.setChannel(3, burstOn && !redSide ? 255 : 0);
        universe.setChannel(4, strobe ? 255 : 0);
        universe.setChannel(5, strobe ? 220 : 0);
    }

    await controller.flush();
    tick = (tick + 1) % 16;
}, 85);
