import {unitToByte as clamp8} from '../../../core/utils';
import type {FixtureModelPlugin} from '../../types';

/** State understood by {@link RGBWW5Fixture} (all values normalized 0..1). */
export type RGBWW5State = {
    dimmer: number;
    rgbww: [number, number, number, number, number];
    rgb: [number, number, number];
    warmWhite: number;
    coolWhite: number;
};

/**
 * Example 5-channel RGBWW fixture plugin.
 *
 * Channels in the `5ch` personality:
 * 1. Red
 * 2. Green
 * 3. Blue
 * 4. Warm White
 * 5. Cool White
 *
 * State input options:
 * - `rgbww`: `[r, g, b, warmWhite, coolWhite]` normalized 0..1
 * - or `rgb`: `[r, g, b]` plus `warmWhite` and `coolWhite`
 * - optional `dimmer` master value 0..1 applied to all channels
 */
export const RGBWW5Fixture: FixtureModelPlugin<RGBWW5State> = {
    manufacturerId: 0x1234,
    vendor: 'ExampleCo',
    model: 'RGBWW 5ch',
    personalities: [{id: '5ch', name: 'RGB+WW+CW', channels: 5}],
    defaultPersonalityId: '5ch',
    match: (id) => id.manufacturerId === 0x1234 && id.modelId === 0x0002,
    encode: ({personalityId, state, ctx}) => {
        if (personalityId !== '5ch') return;
        const f = ctx.frame;
        const base = ctx.base;
        const dimmer = state.dimmer ?? 1;
        const rgb = state.rgb ?? [0, 0, 0];
        const rgbww = state.rgbww ?? [rgb[0], rgb[1], rgb[2], state.warmWhite ?? 0, state.coolWhite ?? 0];

        f[base + 0] = clamp8(rgbww[0] * dimmer);
        f[base + 1] = clamp8(rgbww[1] * dimmer);
        f[base + 2] = clamp8(rgbww[2] * dimmer);
        f[base + 3] = clamp8(rgbww[3] * dimmer);
        f[base + 4] = clamp8(rgbww[4] * dimmer);
    },
};
