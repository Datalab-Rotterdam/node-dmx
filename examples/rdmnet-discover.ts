import {RdmnetDiscovery} from '../src';

type CliOptions = {
    mode: 'dns-sd' | 'mdns';
    serviceName?: string;
    domain?: string;
    timeoutMs?: number;
    iface?: string;
};

function parseArgs(argv: string[]): CliOptions {
    const out: CliOptions = {mode: 'dns-sd'};
    for (const arg of argv) {
        if (arg.startsWith('--mode=')) {
            const v = arg.substring('--mode='.length);
            if (v === 'dns-sd' || v === 'mdns') out.mode = v;
        } else if (arg.startsWith('--service=')) {
            out.serviceName = arg.substring('--service='.length);
        } else if (arg.startsWith('--domain=')) {
            out.domain = arg.substring('--domain='.length);
        } else if (arg.startsWith('--timeout=')) {
            const n = Number(arg.substring('--timeout='.length));
            if (Number.isFinite(n) && n > 0) out.timeoutMs = Math.round(n);
        } else if (arg.startsWith('--iface=')) {
            out.iface = arg.substring('--iface='.length);
        }
    }
    return out;
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    const services = opts.mode === 'mdns'
        ? await RdmnetDiscovery.discoverMdns({
            serviceName: opts.serviceName,
            timeoutMs: opts.timeoutMs,
            iface: opts.iface,
        })
        : await RdmnetDiscovery.discoverDnsSd({
            serviceName: opts.serviceName,
            domain: opts.domain,
        });

    console.log(`Found ${services.length} RDMnet service(s) via ${opts.mode}`);
    for (const svc of services) {
        console.log(`- ${svc.host}:${svc.port} (${svc.addresses.join(', ') || 'no-address'}) scope=${svc.txt.scope ?? '-'}`);
    }
}

void main();
