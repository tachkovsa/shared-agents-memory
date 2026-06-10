import { describe, expect, it } from 'vitest';
import { DEFAULT_LIFECYCLE, resolveLifecycle } from './defaults.js';

/** Foundation guard (#27): lifecycle config resolves uniformly across new and
 * pre-#27 namespace files. */
describe('resolveLifecycle', () => {
  it('fills every field from defaults when the namespace omits them', () => {
    expect(resolveLifecycle({} as never)).toEqual(DEFAULT_LIFECYCLE);
  });

  it('keeps explicit values, including a meaningful null', () => {
    const resolved = resolveLifecycle({
      decay_weight: 0.2,
      soft_delete_after_days: 90,
      hard_delete_grace_days: 7,
      staleness_audit_enabled: false,
      staleness_audit_batch_size: 25,
      filesystem_audit_root: '/repos/app',
    });
    expect(resolved).toEqual({
      decay_weight: 0.2,
      soft_delete_after_days: 90,
      hard_delete_grace_days: 7,
      staleness_audit_enabled: false,
      staleness_audit_batch_size: 25,
      filesystem_audit_root: '/repos/app',
    });
  });

  it('treats soft_delete_after_days=null as rank-only, not "use default"', () => {
    const resolved = resolveLifecycle({ soft_delete_after_days: null } as never);
    expect(resolved.soft_delete_after_days).toBeNull();
  });
});
