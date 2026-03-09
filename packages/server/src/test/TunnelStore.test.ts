import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelStore } from '../TunnelStore';

describe('TunnelStore', () => {
    afterEach(() => {
        // Clean up tunnels after each test
        for (const key of Object.keys(TunnelStore.instance.tunnels)) {
            delete TunnelStore.instance.tunnels[key];
        }
    });

    it('should be a singleton', () => {
        assert.strictEqual(TunnelStore.instance, TunnelStore.instance);
    });

    it('should start with empty tunnels', () => {
        assert.deepEqual(Object.keys(TunnelStore.instance.tunnels), []);
    });

    it('should store and retrieve tunnel entities', () => {
        const entity = { cxn: {} as any, socket: {} as any };
        TunnelStore.instance.tunnels['mysubdomain'] = entity;
        assert.strictEqual(TunnelStore.instance.tunnels['mysubdomain'], entity);
    });

    it('should allow deletion of tunnel entities', () => {
        TunnelStore.instance.tunnels['test'] = { cxn: {} as any, socket: {} as any };
        delete TunnelStore.instance.tunnels['test'];
        assert.equal(TunnelStore.instance.tunnels['test'], undefined);
    });
});
