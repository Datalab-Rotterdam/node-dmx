import {unitToByte as clamp8} from '../../../core/utils';
import type {FixtureModelPlugin} from '../../types';

/** State understood by {@link RGBDimmerFixture} (all values normalized 0..1). */
export type RGBDimmerState = {
    dimmer: number;
    rgb: [number, number, number];
};

/**
 * Example 4-channel RGB dimmer fixture plugin.
 *
 * Channels in the `4ch` personality:
 * 1. Dimmer
 * 2. Red
 * 3. Green
 * 4. Blue
 */
export const RGBDimmerFixture: FixtureModelPlugin<RGBDimmerState> = {
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
        const dimmer = clamp8(state.dimmer ?? 1);
        const rgb = state.rgb ?? [0, 0, 0];
        f[base + 0] = dimmer;
        f[base + 1] = clamp8(rgb[0]);
        f[base + 2] = clamp8(rgb[1]);
        f[base + 3] = clamp8(rgb[2]);
    },
};
