import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: '10.0.0.102', reuseAddr: true});
const universe1 = controller.addUniverse(1);
const universe2 = controller.addUniverse(2);
const universe3 = controller.addUniverse(3);
const universe4 = controller.addUniverse(4);

const universes = [universe1, universe2, universe3, universe4];
const rgbwwChannels = [1, 2, 3, 4, 5];
const stepMs = 150;
const level = 255;

let step = 0;

setInterval(async () => {
    for (let universeIndex = 0; universeIndex < universes.length; universeIndex += 1) {
        const activeChannel = rgbwwChannels[(step + universeIndex) % rgbwwChannels.length];
        const activeUniverse = universes[universeIndex];

        for (const channel of rgbwwChannels) {
            activeUniverse.setChannel(channel, channel === activeChannel ? level : 0);
        }
    }

    await controller.flush();
    step = (step + 1) % rgbwwChannels.length;
}, stepMs);
