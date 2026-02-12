import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: "10.0.0.102", reuseAddr: true});
const universes = [
    controller.addUniverse(1),
    controller.addUniverse(2),
    controller.addUniverse(3),
    controller.addUniverse(4),
];

const CHANNEL_R = 1;
const CHANNEL_G = 2;
const CHANNEL_B = 3;
const CHANNEL_W1 = 4;
const CHANNEL_W2 = 5;

const frameMs = 25;
const hueStep = 2;
const universeHueOffset = 90;
const whiteLevel =0;

const hueToRgb = (hue: number): {r: number; g: number; b: number} => {
    const c = 1;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));

    let r = 0;
    let g = 0;
    let b = 0;

    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    return {
        r: Math.round(r * 255),
        g: Math.round(g * 255),
        b: Math.round(b * 255),
    };
};

let baseHue = 0;

setInterval(async () => {
    for (let i = 0; i < universes.length; i += 1) {
        const hue = (baseHue + i * universeHueOffset) % 360;
        const {r, g, b} = hueToRgb(hue);
        const universe = universes[i];

        universe.setChannel(CHANNEL_R, r);
        universe.setChannel(CHANNEL_G, g);
        universe.setChannel(CHANNEL_B, b);
        universe.setChannel(CHANNEL_W1, whiteLevel);
        universe.setChannel(CHANNEL_W2, whiteLevel);
    }

    await controller.flush();
    baseHue = (baseHue + hueStep) % 360;
}, frameMs);
