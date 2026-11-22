/// <reference types="vitest" />
// Configure Vitest (https://vitest.dev/config/)
import {builtinModules} from 'module';
import {defineConfig} from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/index.ts',
            formats: ['es', 'cjs'],
            // "type": "module" makes Node treat every .js file as ESM, so the
            // CommonJS bundle must use the .cjs extension to be require()-able.
            fileName: (format) => (format === 'cjs' ? 'index.cjs' : `index.${format}.js`)
        },
        rollupOptions: {
            // Keep every Node.js builtin (bare and `node:` prefixed) out of the bundle.
            external: [...builtinModules, /^node:/],
        },
        sourcemap: true,
        target: 'node20'
    },
    plugins: [dts()]
});
