// 手机软键盘回车 = 换行（enter-key.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyEnter, softKeyboardOpen, startMobileEnterKey, SOFT_KEYBOARD_GAP } from '../client/mobile/enter-key.mjs';

/** 最小假元素：只有 closest 参与判定。 */
class FakeElement {
  constructor(insideComposer) {
    this.insideComposer = insideComposer;
  }

  closest(selector) {
    return selector === '[data-composer-input]' && this.insideComposer ? this : null;
  }
}

/** 造一个只有 enter-key 需要的 API 的假 window，并记录它注册的监听器。 */
function fakeWindow({ coarse = true, innerHeight = 800, keyboard = true, present = true } = {}) {
  const listeners = [];
  const doc = {
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture });
    },
    removeEventListener(type, fn, capture) {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  const view = {
    document: doc,
    Element: FakeElement,
    innerHeight,
    visualViewport: keyboard ? { height: innerHeight - 300 } : { height: innerHeight },
    matchMedia: () => ({ matches: coarse }),
  };
  return { view, listeners, present };
}

/** 造一个可写的 keydown 事件。 */
function keydown(overrides = {}) {
  const event = {
    key: 'Enter',
    isComposing: false,
    keyCode: 13,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    target: new FakeElement(true),
    prevented: 0,
    stopped: 0,
    preventDefault() {
      event.prevented += 1;
      event.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      event.stopped += 1;
    },
    ...overrides,
  };
  return event;
}

/** 装上监听并取出注册项。 */
function install(options) {
  const { view, listeners } = fakeWindow(options);
  const dispose = startMobileEnterKey(view);
  const registered = listeners.find((l) => l.type === 'keydown');
  assert.ok(registered, '必须注册 keydown 监听');
  return { event: view, dispose, registered, listeners };
}

test('classifyEnter：桌面（非触屏主指针）永远交给官方', () => {
  assert.equal(classifyEnter({ key: 'Enter' }, { coarsePointer: false, softKeyboardOpen: true }), 'pass');
  assert.equal(classifyEnter({ key: 'Enter' }, { coarsePointer: false, softKeyboardOpen: false }), 'pass');
});

test('classifyEnter：手机软键盘的裸回车改成换行', () => {
  assert.equal(
    classifyEnter({ key: 'Enter', keyCode: 13 }, { coarsePointer: true, softKeyboardOpen: true }),
    'line-break',
  );
});

test('classifyEnter：软键盘没弹出（接了物理键盘）时保持回车发送', () => {
  assert.equal(
    classifyEnter({ key: 'Enter', keyCode: 13 }, { coarsePointer: true, softKeyboardOpen: false }),
    'pass',
  );
});

test('classifyEnter：Chrome 的触摸来源标记优先于视口推断', () => {
  const env = { coarsePointer: true, softKeyboardOpen: true };
  assert.equal(classifyEnter({ key: 'Enter', firesTouchEvents: false }, env), 'pass');
  assert.equal(
    classifyEnter({ key: 'Enter', firesTouchEvents: true }, { coarsePointer: true, softKeyboardOpen: false }),
    'line-break',
  );
});

test('classifyEnter：Shift/Ctrl/Alt/Cmd + Enter 原样交给官方', () => {
  const env = { coarsePointer: true, softKeyboardOpen: true };
  for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(classifyEnter({ key: 'Enter', [modifier]: true }, env), 'pass', modifier);
  }
});

test('classifyEnter：输入法组合中的回车不动', () => {
  const env = { coarsePointer: true, softKeyboardOpen: true };
  assert.equal(classifyEnter({ key: 'Enter', isComposing: true }, env), 'pass');
  assert.equal(classifyEnter({ key: 'Enter', keyCode: 229 }, env), 'pass');
});

test('classifyEnter：非 Enter 键不动', () => {
  const env = { coarsePointer: true, softKeyboardOpen: true };
  assert.equal(classifyEnter({ key: 'a' }, env), 'pass');
  assert.equal(classifyEnter({ key: 'NumpadEnter' }, env), 'pass');
});

test('softKeyboardOpen：用视觉视口与布局视口的落差判断', () => {
  assert.equal(softKeyboardOpen({ innerHeight: 800, visualViewport: { height: 800 - SOFT_KEYBOARD_GAP - 1 } }), true);
  assert.equal(softKeyboardOpen({ innerHeight: 800, visualViewport: { height: 800 - SOFT_KEYBOARD_GAP } }), false);
  assert.equal(softKeyboardOpen({ innerHeight: 800, visualViewport: { height: 800 } }), false);
  // 没有 visualViewport：按手机处理，退化为换行
  assert.equal(softKeyboardOpen({ innerHeight: 800 }), true);
});

test('startMobileEnterKey：捕获阶段注册在 document 上，卸载时摘掉', () => {
  const { dispose, registered, listeners } = install();
  assert.equal(registered.capture, true, '必须在捕获阶段，早于 Lexical 根节点的 keydown');
  dispose();
  assert.equal(listeners.length, 0, 'dispose 后监听器清空');
});

test('startMobileEnterKey：把软键盘回车改写成 Shift+Enter，且不 preventDefault', () => {
  const { registered } = install({ keyboard: true });
  const event = keydown();
  registered.fn(event);
  assert.equal(event.shiftKey, true, '下游看到的就是 Shift+Enter');
  assert.equal(event.prevented, 0, '不能拦掉浏览器自己的换行');
});

test('startMobileEnterKey：接了物理键盘时保持回车发送', () => {
  const { registered } = install({ keyboard: false });
  const event = keydown();
  registered.fn(event);
  assert.equal(event.shiftKey, false, '硬件键盘的回车不能被改写');
  assert.equal(event.prevented, 0);
});

test('startMobileEnterKey：桌面、输入法、修饰键、非 composer 目标都不改写', () => {
  const cases = [
    { options: { coarse: false, keyboard: true }, event: () => keydown() },
    { options: {}, event: () => keydown({ isComposing: true }) },
    { options: {}, event: () => keydown({ keyCode: 229 }) },
    { options: {}, event: () => keydown({ shiftKey: true }) },
    { options: {}, event: () => keydown({ target: new FakeElement(false) }) },
  ];
  for (const { options, event: make } of cases) {
    const { registered } = install(options);
    const event = make();
    const before = event.shiftKey;
    registered.fn(event);
    assert.equal(event.shiftKey, before, 'shiftKey 不能被改写');
    assert.equal(event.prevented, 0);
  }
});

test('mobile-apply 注册了软键盘回车策略', () => {
  const source = readFileSync(new URL('../client/mobile/mobile-apply.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ startMobileEnterKey \} from '\.\/enter-key\.mjs'/, '要引入 enter-key');
  assert.match(source, /ctx\.effect\(\(\) => startMobileEnterKey\(\)/, '要用 ctx.effect 挂载（随插件卸载）');
});
