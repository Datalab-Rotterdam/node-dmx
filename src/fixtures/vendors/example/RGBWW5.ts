import {FixtureModelPlugin} from '../../types';

/** Convert normalized value in the range 0-1 to DMX 0-255. */
function clamp8(value: number): number {
    if (value <= 0) return 0;
    if (value >= 1) return 255;
    return (value * 255) & 0xff;
}

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
export const RGBWW5Fixture: FixtureModelPlugin = {
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
        const dimmer = (state.dimmer as number) ?? 1;
        const rgbww = (state.rgbww as [number, number, number, number, number]) ?? [
            ((state.rgb as [number, number, number] | undefined) ?? [0, 0, 0])[0],
            ((state.rgb as [number, number, number] | undefined) ?? [0, 0, 0])[1],
            ((state.rgb as [number, number, number] | undefined) ?? [0, 0, 0])[2],
            (state.warmWhite as number) ?? 0,
            (state.coolWhite as number) ?? 0,
        ];

        f[base + 0] = clamp8(rgbww[0] * dimmer);
        f[base + 1] = clamp8(rgbww[1] * dimmer);
        f[base + 2] = clamp8(rgbww[2] * dimmer);
        f[base + 3] = clamp8(rgbww[3] * dimmer);
        f[base + 4] = clamp8(rgbww[4] * dimmer);
    },
};
