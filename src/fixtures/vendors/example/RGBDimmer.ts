import {FixtureModelPlugin} from '../../types';

/** Convert normalized value in the range 0-1 to DMX 0-255. */
function clamp8(value: number): number {
    if (value <= 0) return 0;
    if (value >= 1) return 255;
    return (value * 255) & 0xff;
}

/**
 * Example 4-channel RGB dimmer fixture plugin.
 *
 * Channels in the `4ch` personality:
 * 1. Dimmer
 * 2. Red
 * 3. Green
 * 4. Blue
 */
export const RGBDimmerFixture: FixtureModelPlugin = {
    manufacturerId: 0x1234,
    vendor: 'ExampleCo',
    model: 'RGB Dimmer',
    personalities: [{id: '4ch', name: 'Dimmer+RGB', channels: 4}],
    defaultPersonalityId: '4ch',
    match: (id) => id.manufacturerId === 0x1234 && id.modelId === 0x0001,
    encode: ({personalityId, state, ctx}) => {
        if (personalityId !== '4ch') return;
        const f = ctx.frame;
        const base = ctx.base;
        const dimmer = clamp8((state.dimmer as number) ?? 1);
        const rgb = (state.rgb as [number, number, number]) ?? [0, 0, 0];
        f[base + 0] = dimmer;
        f[base + 1] = clamp8(rgb[0]);
        f[base + 2] = clamp8(rgb[1]);
        f[base + 3] = clamp8(rgb[2]);
    },
};
