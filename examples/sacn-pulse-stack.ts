import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universes = [controller.addUniverse(1), controller.addUniverse(2), controller.addUniverse(3), controller.addUniverse(4)];
const channels = [1, 2, 3, 4, 5];

let frame = 0;

setInterval(async () => {
    for (let u = 0; u < universes.length; u += 1) {
        const universe = universes[u];
        const active = channels[(Math.floor(frame / 26) + u) % channels.length];
        const pulse = Math.floor(255 * Math.pow((Math.sin(frame * 0.12) + 1) / 2, 2));

        for (const channel of channels) {
            universe.setChannel(channel, channel === active ? pulse : 0);
        }
    }

    await controller.flush();
    frame += 1;
}, 35);
