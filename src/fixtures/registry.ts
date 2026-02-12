/**
 * Simple in-memory fixture registry.
 * @module fixtures/registry
 */
import {FixtureIdentity, FixtureModelPlugin, FixtureRegistry} from './types';

/** Basic array-backed fixture plugin registry. */
export class InMemoryFixtureRegistry implements FixtureRegistry {
    private readonly plugins: FixtureModelPlugin[] = [];

    /** @inheritdoc */
    add(plugin: FixtureModelPlugin): void {
        this.plugins.push(plugin);
    }

    /** @inheritdoc */
    find(identity: FixtureIdentity): FixtureModelPlugin | undefined {
        return this.plugins.find((plugin) => plugin.match(identity));
    }

    /** @inheritdoc */
    all(): FixtureModelPlugin[] {
        return [...this.plugins];
    }
}
