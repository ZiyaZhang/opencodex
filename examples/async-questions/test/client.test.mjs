import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
const packageName = 'dsh-opencodex-async-questions';
const markerAttribute = 'data-dsh-async-question-marker';

// Exercise the shipped ModuleLoader factory. These are contract doubles, not a
// browser, a CSS engine, or an assertion that DSH's UI acceptance has passed.
function harness({ withDocument = true } = {}) {
  const loaded = [];
  const styles = new Set();
  const document = {
    createElement(tag) {
      assert.equal(tag, 'style');
      return {
        attributes: {},
        textContent: '',
        setAttribute(name, value) { this.attributes[name] = value; },
        remove() { styles.delete(this); },
      };
    },
    head: { appendChild(style) { styles.add(style); } },
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(definition) { loaded.push(definition); } } },
    ...(withDocument ? { document } : {}),
  }, { timeout: 1000 });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, packageName);
  const plugin = loaded[0].factory((specifier) => {
    assert.equal(specifier, 'react/jsx-runtime');
    return require(specifier);
  });
  const activeRegistrations = new Set();
  const deferred = [];
  const cleanups = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        assert.equal(name, 'conversation.composer.dock');
        deferred.push(callback);
      },
      register(options, component) {
        const registration = { options, component };
        activeRegistrations.add(registration);
        return () => activeRegistrations.delete(registration);
      },
    },
    effect(effect) {
      const cleanup = effect();
      assert.equal(typeof cleanup, 'function', 'effect must return a disposer');
      cleanups.push(cleanup);
    },
  };
  plugin.apply(ctx);
  assert.equal(activeRegistrations.size, 0, 'registration waits for its slot injection');
  assert.equal(deferred.length, 1);
  const disposeSlot = deferred[0]();
  assert.equal(typeof disposeSlot, 'function', 'injection returns the registration disposer');
  cleanups.push(disposeSlot);
  const registration = [...activeRegistrations][0];
  return {
    plugin, registration, styles, activeRegistrations,
    dispose() { for (const cleanup of cleanups.toReversed()) cleanup(); },
  };
}

function renderMarker(component, sessionId, snapshot) {
  let selectorCalls = 0;
  const result = component({
    sessionId,
    useSessionStatus(selector) {
      selectorCalls += 1;
      return selector(snapshot);
    },
  });
  assert.equal(selectorCalls, 1);
  return result;
}

test('shipped loader registers a session-scoped composer dock contribution', () => {
  const h = harness();
  assert.deepEqual(Array.from(h.plugin.inject), ['slots']);
  assert.equal(h.registration.options.name, 'conversation.composer.dock');
  assert.equal(h.registration.options.id, packageName);
  assert.equal(h.registration.options.order, 0);
  const marker = renderMarker(h.registration.component, 'session-a', new Map([
    ['session-a', { pendingInteraction: { kind: 'question' } }],
  ]));
  assert.equal(marker.type, 'span');
  assert.equal(marker.props[markerAttribute], '');
  assert.equal(marker.props['aria-hidden'], 'true');
  assert.equal(marker.props.children, undefined);
  h.dispose();
});

test('plan review, approvals, offline blockers, and inactive sessions stay excluded', () => {
  const h = harness();
  for (const kind of ['plan-review', 'approval', 'offline', 'unknown']) {
    assert.equal(renderMarker(h.registration.component, 'active', new Map([
      ['active', { pendingInteraction: { kind } }],
      ['another-session', { pendingInteraction: { kind: 'question' } }],
    ])), null, kind);
  }
  for (const active of [undefined, {}, { pendingInteraction: undefined }]) {
    assert.equal(renderMarker(h.registration.component, 'active', new Map([
      ['active', active],
      ['another-session', { pendingInteraction: { kind: 'question' } }],
    ])), null);
  }
  assert.equal(renderMarker(h.registration.component, undefined, {
    get() { assert.fail('a sessionless composer must not select another session'); },
  }), null);
  h.dispose();
});

test('selector follows the requested session and question-to-plan-to-idle transitions', () => {
  const h = harness();
  const snapshot = new Map([
    ['session-a', { pendingInteraction: { kind: 'question' } }],
    ['session-b', {}],
  ]);
  const render = (id) => renderMarker(h.registration.component, id, snapshot);
  assert.notEqual(render('session-a'), null);
  assert.equal(render('session-b'), null);
  snapshot.set('session-a', { pendingInteraction: { kind: 'plan-review' } });
  assert.equal(render('session-a'), null);
  snapshot.set('session-a', {});
  assert.equal(render('session-a'), null);
  snapshot.set('session-b', { pendingInteraction: { kind: 'question' } });
  assert.equal(render('session-a'), null);
  assert.notEqual(render('session-b'), null);
  h.dispose();
});

test('unload removes only its stylesheet and releases the slot registration', () => {
  const h = harness();
  assert.equal(h.styles.size, 1);
  const [style] = h.styles;
  assert.equal(style.attributes[markerAttribute], packageName);
  assert.match(style.textContent, /\[data-composer-seat\]:has\(\[data-dsh-async-question-marker\]\)/);
  assert.match(style.textContent, /data-chain-overlay-fallback="conversation\.composer"/);
  // CSS text inspection checks packaging/scope, not layout or computed styles.
  const unrelatedStyle = {};
  h.styles.add(unrelatedStyle);
  h.dispose();
  assert.equal(h.activeRegistrations.size, 0);
  assert.deepEqual([...h.styles], [unrelatedStyle]);
  h.dispose();
  assert.deepEqual([...h.styles], [unrelatedStyle]);
});

test('non-DOM evaluation keeps a valid cleanup and disposable slot contribution', () => {
  const h = harness({ withDocument: false });
  assert.equal(h.styles.size, 0);
  assert.equal(h.activeRegistrations.size, 1);
  h.dispose();
  assert.equal(h.activeRegistrations.size, 0);
});
