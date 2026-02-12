import {Receiver, type Packet} from '../src';

type CliOptions = {
    universes: number[];
    iface?: string;
    port?: number;
    fps: number;
};

function parseListArg(value: string): number[] {
    const nums = value
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v >= 1 && v <= 63999);

    return nums.length > 0 ? nums : [1];
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        universes: [1],
        fps: 8,
    };

    for (const arg of argv) {
        if (arg.startsWith('--universes=')) {
            options.universes = parseListArg(arg.substring('--universes='.length));
        } else if (arg.startsWith('--iface=')) {
            options.iface = arg.substring('--iface='.length);
        } else if (arg.startsWith('--port=')) {
            const port = Number(arg.substring('--port='.length));
            if (Number.isInteger(port) && port > 0 && port <= 65535) {
                options.port = port;
            }
        } else if (arg.startsWith('--fps=')) {
            const fps = Number(arg.substring('--fps='.length));
            if (Number.isFinite(fps) && fps >= 1 && fps <= 60) {
                options.fps = Math.round(fps);
            }
        }
    }

    return options;
}

function payloadToFrame(packet: Packet): Uint8Array {
    if (packet.payloadAsBuffer) {
        const frame = new Uint8Array(512);
        frame.set(packet.payloadAsBuffer.subarray(0, 512));
        return frame;
    }

    const frame = new Uint8Array(512);
    const payload = packet.payload;
    for (const key of Object.keys(payload)) {
        const ch = Number(key);
        if (Number.isInteger(ch) && ch >= 1 && ch <= 512) {
            const pct = payload[ch] ?? 0;
            frame[ch - 1] = Math.max(0, Math.min(255, Math.round((pct / 100) * 255)));
        }
    }
    return frame;
}

function formatMatrix(frame: Uint8Array): string {
    const cols = 16;
    const rows = 32;
    const lines: string[] = [];

    const header = Array.from({length: cols}, (_, i) => String(i + 1).padStart(3, ' ')).join(' ');
    lines.push(`      ${header}`);

    for (let row = 0; row < rows; row++) {
        const startChannel = row * cols + 1;
        const values: string[] = [];
        for (let col = 0; col < cols; col++) {
            values.push(String(frame[row * cols + col] ?? 0).padStart(3, ' '));
        }
        lines.push(`Ch ${String(startChannel).padStart(3, ' ')} ${values.join(' ')}`);
    }

    return lines.join('\n');
}

const options = parseArgs(process.argv.slice(2));
const receiver = new Receiver({
    universes: options.universes,
    iface: options.iface,
    port: options.port,
    reuseAddr: true,
});

type State = {
    frame: Uint8Array;
    source: string;
    sequence: number;
    receivedAt: number;
};

const stateByUniverse = new Map<number, State>();

for (const universe of options.universes) {
    stateByUniverse.set(universe, {
        frame: new Uint8Array(512),
        source: '-',
        sequence: 0,
        receivedAt: 0,
    });
}

receiver.on('packet', (packet) => {
    stateByUniverse.set(packet.universe, {
        frame: payloadToFrame(packet),
        source: packet.sourceAddress ?? '-',
        sequence: packet.sequence,
        receivedAt: Date.now(),
    });
});

receiver.on('PacketCorruption', (error) => {
    console.error('[PacketCorruption]', error.message);
});

receiver.on('PacketOutOfOrder', (error) => {
    console.error('[PacketOutOfOrder]', error.message);
});

receiver.on('error', (error) => {
    console.error('[ReceiverError]', error.message);
});

function render(): void {
    process.stdout.write('\x1Bc');

    console.log('node-dmx sACN listener matrix');
    console.log(`universes=${options.universes.join(',')} iface=${options.iface ?? 'default'} port=${options.port ?? 5568}`);
    console.log('Press Ctrl+C to exit.\n');

    for (const universe of options.universes) {
        const state = stateByUniverse.get(universe);
        if (!state) continue;

        const ageMs = state.receivedAt === 0 ? '-' : String(Date.now() - state.receivedAt);
        console.log(`Universe ${universe} | src=${state.source} | seq=${state.sequence} | ageMs=${ageMs}`);
        console.log(formatMatrix(state.frame));
        console.log('');
    }
}

const tickMs = Math.max(16, Math.round(1000 / options.fps));
const timer = setInterval(render, tickMs);
render();

function shutdown(): void {
    clearInterval(timer);
    receiver.close(() => {
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
