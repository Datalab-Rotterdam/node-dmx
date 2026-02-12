import {DMXController} from "../src";

const controller = new DMXController({
    protocol:'sacn', iface: "10.0.0.102", reuseAddr: true
})

const universe = controller.addUniverse(1);
const universe2 = controller.addUniverse(2);
const universe3 = controller.addUniverse(3);
const universe4 = controller.addUniverse(4);

const brightness = 255

for (let i = 1; i <= 5; i++) {
    universe.setChannel(i,brightness);
    universe2.setChannel(i,brightness);
    universe3.setChannel(i,brightness);
    universe4.setChannel(i,brightness);
}
await controller.flush();


setInterval(async () => {
    console.log("Loop");
    // await controller.flush();

}, 10000)

// setTimeout(() => {
//     console.log("Exit")
// },10000)

