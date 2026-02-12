import {DMXController, Fixture, RGBWW5Fixture} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
controller.addUniverse(1);

const fixture = new Fixture(
    controller,
    RGBWW5Fixture,
    1, // universe
    1, // start address
    '5ch',
);

let t = 0;
const frameMs = 50;

setInterval(async () => {
    const phase = (Math.sin(t) + 1) / 2;
    const inverse = 1 - phase;

    fixture.set({
        dimmer: 1,
        rgbww: [
            phase,          // red
            0.2,            // green
            inverse,        // blue
            phase * 0.8,    // warm white
            inverse * 0.8,  // cool white
        ],
    });
    fixture.render(Date.now());
    await controller.flush();
    t += 0.08;
}, frameMs);

