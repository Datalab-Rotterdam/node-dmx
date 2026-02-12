import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];

const hueToRgb = (h: number): {r: number; g: number; b: number} => {
    const c = 1;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));

    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    return {r: Math.round(r * 180), g: Math.round(g * 180), b: Math.round(b * 180)};
};

let hue = 0;
const sparkle = [0, 0, 0, 0];

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const rgb = hueToRgb((hue + u * 40) % 360);

        sparkle[u] = Math.max(0, sparkle[u] - 35);
        if (Math.random() < 0.14) sparkle[u] = 255;

        universe.setChannel(1, rgb.r);
        universe.setChannel(2, rgb.g);
        universe.setChannel(3, rgb.b);
        universe.setChannel(4, sparkle[u]);
        universe.setChannel(5, Math.max(0, sparkle[u] - 20));
    }

    await controller.flush();
    hue = (hue + 1.2) % 360;
}, 30);
