import {DMXController} from '../src';

const controller = new DMXController({protocol: 'sacn', iface: "10.0.0.102", reuseAddr: true});
const universe = controller.addUniverse(1);
const universe2 = controller.addUniverse(2);
const universe3 = controller.addUniverse(3);
const universe4 = controller.addUniverse(4);



let value = 0;
let direction = 1;

setInterval(async () => {
    value += direction * 5;
    if (value >= 255) {
        value = 255;
        direction = -1;
    }
    if (value <= 0) {
        value = 0;
        direction = 1;
    }

    //universe.setChannel(1, value);
    //universe.setChannel(2, value);
    //universe.setChannel(3, value);
    // universe.setChannel( 4, value);
    universe.setChannel( 1, value);
    universe2.setChannel( 2, value);
    universe3.setChannel( 3, value);
    universe4.setChannel( 4, value);
    await controller.flush();
}, 25);
