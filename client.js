window.__ModuleLoader__.load({
  id: '@xth26/dsh-plan-build-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BADGE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 10px',
      borderRadius: '999px',
      fontSize: '12px',
      lineHeight: '18px',
      border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.35))',
      color: 'var(--dsw-alias-text-secondary, inherit)',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      alignSelf: 'center',
    };
    const PLAN_DOT = { width: '7px', height: '7px', borderRadius: '50%', background: 'var(--dsw-alias-text-secondary, #888)', flex: 'none' };
    const BUILD_DOT = { width: '7px', height: '7px', borderRadius: '50%', background: 'var(--dsw-alias-accent, #4a7dbf)', flex: 'none' };

    /**
     * Resident mode label under the composer. Session-scope slot components
     * receive the framework standard kit: `useProjection(key)` reads the
     * Host-pushed whole projection value, so the `permissions` unit's
     * `{ currentValue }` view arrives already computed.
     */
    function ModeLabel(props) {
      const useProjection = props.useProjection;
      const currentValue = useProjection
        ? useProjection('permissions', (v) => (v === undefined || v === null ? undefined : v.currentValue))
        : undefined;
      if (currentValue === 'oc-plan') {
        return h('span', { style: BADGE, title: 'Plan mode: read-only by policy; plan files stay writable' },
          h('span', { style: PLAN_DOT }), 'Plan 只读模式');
      }
      if (currentValue === 'oc-build') {
        return h('span', { style: BADGE, title: 'Build mode: edits allowed within the sandbox' },
          h('span', { style: BUILD_DOT }), 'Build 模式');
      }
      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'plan-build-mode-label',
          order: 20,
        }, ModeLabel));
      },
    };
  },
});
