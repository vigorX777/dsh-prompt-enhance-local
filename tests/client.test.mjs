/**
 * 离线测试 · Client 半（浏览器状态机，脱离 DSH / 脱离真实 React）
 *
 * client.js 是 window.__ModuleLoader__.load 包装的 lazy-CJS factory，react 由
 * shell 模块表注入（本机 profile 里没有 react npm 包），所以用 vm 沙箱 +
 * 自写 mini-React hooks 运行时驱动 EnhanceButton，逐条验 ACCEPTANCE 阶段 3
 * 的 12 项、阶段 5 的 5.4/5.5/5.6/5.7，以及 3.12 停用回收。
 *
 * 运行：node tests/client.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'client.js');
const SOURCE = fs.readFileSync(CLIENT, 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n        ') : error}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (!Object.is(a, b)) throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function depsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

/* ------------------------------------------------------------------ */
/* mini-React：useState / useRef / useCallback / useEffect + render    */
/* ------------------------------------------------------------------ */
function createHarness(Component, initialProps) {
  let hooks = [];
  let idx = 0;
  let pendingEffects = [];
  let dirty = false;
  let props = initialProps;
  let vnode = null;
  let disposed = false;
  let renders = 0;

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, p, ...children) {
      return { type, props: p || {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = { type: 'state', value: typeof initial === 'function' ? initial() : initial };
      const h = hooks[i];
      const setter = (next) => {
        const value = typeof next === 'function' ? next(h.value) : next;
        if (!Object.is(value, h.value)) { h.value = value; dirty = true; }
      };
      return [h.value, setter];
    },
    useRef(initial) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = { type: 'ref', current: initial };
      return hooks[i];
    },
    useCallback(fn, deps) {
      const i = idx++;
      const prev = hooks[i];
      if (prev && prev.type === 'cb' && depsEqual(prev.deps, deps)) return prev.fn;
      hooks[i] = { type: 'cb', fn, deps };
      return fn;
    },
    useEffect(fn, deps) {
      const i = idx++;
      const prev = hooks[i];
      const shouldRun = !prev || prev.type !== 'effect' || !depsEqual(prev.deps, deps);
      const rec = { type: 'effect', deps, cleanup: prev && prev.type === 'effect' ? prev.cleanup : null };
      hooks[i] = rec;
      if (shouldRun) pendingEffects.push({ fn, rec });
    },
  };

  function render() {
    idx = 0;
    pendingEffects = [];
    let node = Component(props);
    let guard = 0;
    while (node && typeof node.type === 'function' && guard++ < 10) node = node.type(node.props);
    vnode = node;
    renders++;
    for (const { fn, rec } of pendingEffects) {
      if (rec.cleanup) { try { rec.cleanup(); } catch { /* teardown */ } rec.cleanup = null; }
      let cleanup;
      try { cleanup = fn(); } catch { /* effect must not throw in our mock ctx */ }
      rec.cleanup = typeof cleanup === 'function' ? cleanup : null;
    }
    return node;
  }

  async function flush(turns = 12) {
    for (let i = 0; i < turns; i++) {
      await new Promise((r) => setImmediate(r));
      if (dirty) { dirty = false; render(); }
    }
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    for (const h of hooks) {
      if (h && h.type === 'effect' && typeof h.cleanup === 'function') {
        try { h.cleanup(); } catch { /* teardown */ }
        h.cleanup = null;
      }
    }
  }

  return {
    React,
    get vnode() { return vnode; },
    get renders() { return renders; },
    get props() { return props; },
    // Bind the component AFTER the factory has captured this harness's React.
    // Using a second harness would leave hooks bound to the first one's idx.
    setComponent(c) { Component = c; },
    setProps(next) { props = next; dirty = true; },
    schedule() { dirty = true; },
    markClean() { dirty = false; },
    flush,
    unmount,
    render,
  };
}

/** 在 vm 沙箱里执行 client.js，捕获 __ModuleLoader__ 注册与模块导出。 */
function loadClient({ language = 'zh-CN' } = {}) {
  const registrations = [];
  const fetchCalls = [];
  const warnings = [];
  const listeners = new Map();
  let activeElement = null;

  const document = {
    get activeElement() { return activeElement; },
    set activeElement(v) { activeElement = v; },
    addEventListener(type, fn, capture) {
      const arr = listeners.get(type) || [];
      arr.push({ fn, capture });
      listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((l) => l.fn !== fn));
    },
    emit(type, event) {
      for (const l of [...(listeners.get(type) || [])]) l.fn(event);
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    clearListeners() { listeners.clear(); },
  };

  function fetchMock(url, opts) {
    const entry = { url, opts, settled: false, aborted: false };
    entry.promise = new Promise((resolve, reject) => { entry._resolve = resolve; entry._reject = reject; });
    entry.resolve = (body) => {
      if (entry.settled) return;
      entry.settled = true;
      entry._resolve({ json: async () => body });
    };
    entry.reject = (err) => {
      if (entry.settled) return;
      entry.settled = true;
      entry._reject(err);
    };
    fetchCalls.push(entry);
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        entry.aborted = true;
        if (!entry.settled) {
          const e = new Error('The operation was aborted'); e.name = 'AbortError';
          entry.reject(e);
        }
      }, { once: true });
    }
    return entry.promise;
  }

  const sandbox = {
    window: { __ModuleLoader__: { load: (reg) => registrations.push(reg) } },
    navigator: { language },
    document,
    fetch: fetchMock,
    AbortController,
    console: { warn: (...a) => warnings.push(a.join(' ')), log() {} },
    setTimeout, clearTimeout, setImmediate, queueMicrotask,
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' });

  eq(registrations.length, 1, '__ModuleLoader__.load must be called exactly once');
  const reg = registrations[0];
  const harness = createHarness(null, null);
  const exported = reg.factory((name) => {
    if (name === 'react') return harness.React;
    throw new Error(`unexpected require("${name}")`);
  });

  return { reg, exported, harness, document, fetchCalls, warnings, registrations };
}

/** 用 mock ctx 调 apply，拿到 slot 注册出来的组件并挂载。 */
function mount({ language = 'zh-CN', draft = '', withT = true, sessionId = 's1' } = {}) {
  const loaded = loadClient({ language });
  const { exported, harness } = loaded;
  const state = { draft };
  const setDraftCalls = [];
  const sendCalls = [];
  const effects = [];
  const slotInjects = [];
  const slotRegs = [];
  const localeRegs = [];

  const inputActions = {
    setDraft(text) { state.draft = text; setDraftCalls.push(text); harness.schedule(); },
    send(...args) { sendCalls.push(args); },
  };
  const dict = {
    enhance: '增强提示词', enhancing: '增强中…（点击取消）',
    revert: '恢复原文', failed: '增强失败',
  };
  const props = {
    useInput: (selector) => selector(state),
    inputActions,
    sessionId,
    ...(withT ? { t: (key) => dict[key] || (loaded.document ? key : key) } : {}),
  };

  const ctx = {
    effect(fn, label) {
      const cleanup = fn();
      const rec = { label, cleanup, disposed: false };
      // Expose the cordis-style disposer (which flips disposed) as rec.dispose.
      rec.dispose = () => {
        if (!rec.disposed) {
          rec.disposed = true;
          if (typeof cleanup === 'function') cleanup();
        }
      };
      effects.push(rec);
      return rec.dispose;
    },
    locale: {
      register(ns, tables) {
        const rec = { ns, tables, disposed: false };
        localeRegs.push(rec);
        return () => { rec.disposed = true; };
      },
    },
    slots: {
      inject(slotName, cb) {
        const rec = { slotName, disposed: false };
        slotInjects.push(rec);
        const disposeReg = cb();
        return () => { rec.disposed = true; if (typeof disposeReg === 'function') disposeReg(); };
      },
      register(options, Component) {
        const rec = { options, Component, disposed: false };
        slotRegs.push(rec);
        return () => { rec.disposed = true; };
      },
    },
  };

  exported.apply(ctx);
  eq(slotRegs.length, 1, 'apply must register exactly one slot contribution');
  // Use the SAME harness whose React was injected into the factory. Creating a
  // second harness would leave the component's hooks bound to harness A's idx
  // while render() resets harness B's idx -> state corruption on re-render.
  harness.setComponent(slotRegs[0].Component);
  harness.setProps(props);
  harness.render();
  harness.markClean();
  return {
    ...loaded, exported, harness, ctx, state, props,
    setDraftCalls, sendCalls, effects, slotInjects, slotRegs, localeRegs, dict,
  };
}

function findButton(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button') return node;
  for (const child of node.children || []) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
}
function findStyle(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'style') return node;
  for (const child of node.children || []) {
    const found = findStyle(child);
    if (found) return found;
  }
  return null;
}
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.children || []);
  return '';
}
function click(m) {
  const btn = findButton(m.harness.vnode);
  assert(btn, 'button not rendered');
  // Fire-and-forget: onClick in idle/error returns trigger()'s pending promise
  // (it awaits a fetch the test resolves manually). Awaiting it here would
  // deadlock the top-level await; swallow rejections and let flush() re-render.
  const result = btn.props.onClick();
  if (result && typeof result.then === 'function') result.then(() => {}, () => {});
}
function stateOf(m) {
  const btn = findButton(m.harness.vnode);
  return btn ? btn.props['data-state'] : null;
}
function iconOf(m) {
  const btn = findButton(m.harness.vnode);
  if (!btn) return null;
  const kids = btn.children || [];
  for (const k of kids) {
    if (k && typeof k === 'object' && (k.type === 'svg' || (Array.isArray(k) && k.some((x) => x && x.type === 'svg')))) {
      return Array.isArray(k) ? k.find((x) => x && x.type === 'svg') : k;
    }
  }
  return null;
}
function titleOf(m) {
  const btn = findButton(m.harness.vnode);
  return btn ? btn.props.title : null;
}

/* ------------------------------------------------------------------ */
console.log('\n阶段 1 · Bundle 装载形态与模块导出');

await check('client.js 用 window.__ModuleLoader__.load 包装，id 等于包名', () => {
  const { reg } = loadClient();
  eq(reg.id, PKG.name);
  eq(typeof reg.factory, 'function');
});

await check('factory 返回 CommonJS 导出 {name, inject, apply}', () => {
  const { exported } = loadClient();
  eq(exported.name, PKG.name);
  eq(typeof exported.apply, 'function');
  eq(JSON.stringify(exported.inject), JSON.stringify(['slots', 'locale']));
});

await check('factory 副作用自由：仅 require(react)，无 document/fetch 调用直到 apply', () => {
  const { document, fetchCalls, warnings } = loadClient();
  eq(document.listenerCount('keydown'), 0);
  eq(fetchCalls.length, 0);
  eq(warnings.length, 0);
});

await check('apply 注册 locale 词典 + conversation.input.right 槽位（3.2 同排）', () => {
  const m = mount();
  eq(m.localeRegs.length, 1);
  eq(m.localeRegs[0].ns, 'prompt-enhance');
  assert(m.localeRegs[0].tables.zh && m.localeRegs[0].tables.en);
  eq(m.slotInjects.length, 1);
  eq(m.slotInjects[0].slotName, 'conversation.input.right');
  eq(m.slotRegs.length, 1);
  eq(m.slotRegs[0].options.id, 'prompt-enhance');
  eq(m.slotRegs[0].options.name, 'conversation.input.right');
  eq(m.slotRegs[0].options.order, 5);
  eq(m.slotRegs[0].options.locale, 'prompt-enhance');
  eq(typeof m.slotRegs[0].options.inject, 'function');
  eq(typeof m.slotRegs[0].Component, 'function');
  eq(m.effects.length, 2);
});

/* ------------------------------------------------------------------ */
console.log('\n阶段 3 · Client 四态状态机（3.1–3.12）');

await check('3.1 空草稿不渲染按钮', () => {
  const m = mount({ draft: '' });
  eq(findButton(m.harness.vnode), null);
});

await check('3.1b 仅零宽字符/空白的草稿也不渲染', () => {
  const m = mount({ draft: '\u200B\uFEFF  \n ' });
  eq(findButton(m.harness.vnode), null);
});

await check('3.1c 有内容草稿 → ✨ 按钮，title/aria-label 走 props.t', () => {
  const m = mount({ draft: '写个排序函数' });
  eq(stateOf(m), 'idle');
  eq(titleOf(m), '增强提示词');
  eq(findButton(m.harness.vnode).props['aria-label'], '增强提示词');
  eq(findButton(m.harness.vnode).props['aria-busy'], 'false');
  const ic = iconOf(m);
  assert(ic, 'inline SVG icon must render (mature icon set, no external asset)');
  eq(ic.props.className, 'dsh-pe-icon');
  eq(ic.props.stroke, 'currentColor');
  assert(ic.children && ic.children.length >= 1, 'icon must contain path children');
  assert(!m.fetchCalls.length, 'must not enhance automatically');
});

await check('3.1d 无 props.t 时 labelOf 回退到 translate（中文 navigator）', () => {
  const m = mount({ draft: 'x', withT: false });
  eq(titleOf(m), '增强提示词');
  const en = mount({ draft: 'x', withT: false, language: 'en-US' });
  eq(titleOf(en), 'Enhance prompt');
});

await check('5.4 按钮样式只用主题 token，不写死颜色；<style> 随组件渲染', () => {
  const m = mount({ draft: 'x' });
  const btn = findButton(m.harness.vnode);
  eq(btn.props.style.color, 'var(--dsw-alias-label-secondary, inherit)');
  assert(!/#[\da-f]{3,8}/i.test(JSON.stringify(btn.props.style)), 'hard-coded color in inline style');
  const style = findStyle(m.harness.vnode);
  assert(style, '<style> element must be rendered as a React element');
  assert(textOf(style).includes('--dsw-alias-'), 'hover/focus must use theme tokens');
});

await check('5.6 宿主隐藏 standardControls 时组件仍渲染（不依赖该 prop）', () => {
  const m = mount({ draft: 'x' });
  assert(findButton(m.harness.vnode), 'button must survive missing standardControls');
  assert(!('standardControls' in m.props), 'component must not depend on standardControls');
});

await check('3.5 成功 → 整段替换草稿、按钮变 ↩、绝不自动发送（3.3）', async () => {
  const m = mount({ draft: '原文' });
  await click(m);
  await m.harness.flush(3);
  eq(m.fetchCalls.length, 1);
  eq(m.fetchCalls[0].url, '/prompt-enhance/enhance');
  eq(m.fetchCalls[0].opts.method, 'POST');
  eq(m.fetchCalls[0].opts.headers['content-type'], 'application/json');
  eq(JSON.parse(m.fetchCalls[0].opts.body).text, '原文');
  eq(stateOf(m), 'enhancing');
  eq(findButton(m.harness.vnode).props['aria-busy'], 'true');
  const spinIcon = iconOf(m);
  assert(spinIcon && String(spinIcon.props.className).includes('dsh-pe-spin'), 'enhancing icon must carry the spin class');

  m.fetchCalls[0].resolve({ success: true, text: '增强版' });
  await m.harness.flush();
  eq(m.state.draft, '增强版');
  eq(JSON.stringify(m.setDraftCalls), JSON.stringify(['增强版']));
  eq(stateOf(m), 'revert');
  eq(m.state.draft, '增强版');
  eq(m.sendCalls.length, 0, 'must NEVER auto-send');
});

await check('3.6 点 ↩ → 草稿回到点击前原文、按钮回 ✨', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(2);
  m.fetchCalls[0].resolve({ success: true, text: '增强版' });
  await m.harness.flush();
  await click(m);
  await m.harness.flush();
  eq(m.state.draft, '原文');
  eq(stateOf(m), 'idle');
  eq(JSON.stringify(m.setDraftCalls), JSON.stringify(['增强版', '原文']));
});

await check('3.4 加载中再点 → abort 在途、静默回 idle、草稿一字不变', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(3);
  eq(stateOf(m), 'enhancing');
  await click(m);
  await m.harness.flush();
  eq(m.fetchCalls[0].aborted, true, 'in-flight fetch must be aborted');
  eq(stateOf(m), 'idle');
  eq(m.state.draft, '原文');
  eq(m.setDraftCalls.length, 0);

  // 迟到的成功结果不得写回
  m.fetchCalls[0].resolve({ success: true, text: '迟到结果' });
  await m.harness.flush();
  eq(m.state.draft, '原文');
  eq(m.setDraftCalls.length, 0);
});

await check('3.7 手改草稿 → 按钮立刻回 ✨、还原点失效，再点不会还原成旧文', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(2);
  m.fetchCalls[0].resolve({ success: true, text: '增强版' });
  await m.harness.flush();
  eq(stateOf(m), 'revert');

  m.state.draft = '我手改了';
  m.harness.schedule();
  await m.harness.flush();
  eq(stateOf(m), 'idle');

  // 此时再点应触发一次新的增强，而不是把旧文写回
  await click(m); await m.harness.flush(3);
  eq(m.fetchCalls.length, 2);
  eq(JSON.parse(m.fetchCalls[1].opts.body).text, '我手改了');
  eq(m.state.draft, '我手改了');
});

await check('3.8 Cmd/Ctrl+Z（焦点在输入区）→ 一步回原文、图标同步回 ✨', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(2);
  m.fetchCalls[0].resolve({ success: true, text: '增强版' });
  await m.harness.flush();
  eq(stateOf(m), 'revert');

  m.document.activeElement = { tagName: 'TEXTAREA', isContentEditable: false };
  let prevented = 0, stopped = 0;
  m.document.emit('keydown', {
    metaKey: true, ctrlKey: false, shiftKey: false, key: 'z',
    preventDefault() { prevented++; }, stopPropagation() { stopped++; },
  });
  await m.harness.flush();
  eq(prevented, 1);
  eq(stopped, 1);
  eq(m.state.draft, '原文');
  eq(stateOf(m), 'idle');
});

await check('3.8b 草稿已分歧时不拦截 Cmd+Z（按键交还宿主）', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(2);
  m.fetchCalls[0].resolve({ success: true, text: '增强版' });
  await m.harness.flush();
  m.state.draft = '别的文字';
  m.harness.schedule(); await m.harness.flush();
  m.document.activeElement = { tagName: 'INPUT', isContentEditable: false };
  let prevented = 0;
  m.document.emit('keydown', {
    metaKey: true, key: 'z', shiftKey: false,
    preventDefault() { prevented++; }, stopPropagation() {},
  });
  eq(prevented, 0);
  eq(m.state.draft, '别的文字');
});

await check('3.8c 焦点不在输入区时不拦截；非 z / 带 Shift 不拦截', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(2);
  m.fetchCalls[0].resolve({ success: true, text: '增强版' });
  await m.harness.flush();
  let prevented = 0;
  const ev = (over) => ({
    metaKey: true, key: 'z', shiftKey: false,
    preventDefault() { prevented++; }, stopPropagation() {}, ...over,
  });
  m.document.activeElement = null;
  m.document.emit('keydown', ev({}));
  m.document.activeElement = { tagName: 'TEXTAREA' };
  m.document.emit('keydown', ev({ key: 'a' }));
  m.document.emit('keydown', ev({ shiftKey: true }));
  eq(prevented, 0);
  eq(m.state.draft, '增强版');
});

await check('3.9 切换会话 → 重置状态、abort 在途请求', async () => {
  const m = mount({ draft: '原文', sessionId: 's1' });
  await click(m); await m.harness.flush(3);
  eq(stateOf(m), 'enhancing');
  m.props.sessionId = 's2';
  m.harness.setProps(m.props);
  await m.harness.flush();
  eq(m.fetchCalls[0].aborted, true);
  eq(stateOf(m), 'idle');
  eq(m.state.draft, '原文');
  eq(m.setDraftCalls.length, 0);
});

await check('3.10 失败 → 草稿不变、按钮 ⚠、title 显示错误原文、无 toast', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(3);
  m.fetchCalls[0].resolve({ success: false, text: '', code: 'llm_error', error: '模型超时，请稍后重试' });
  await m.harness.flush();
  eq(m.state.draft, '原文');
  eq(m.setDraftCalls.length, 0);
  eq(stateOf(m), 'error');
  eq(titleOf(m), '模型超时，请稍后重试');
  eq(m.warnings.length, 0, 'no toast / no console.warn on business failure');
});

await check('3.10b fetch 抛错（AbortError 除外）→ error 态且 title 带原因', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(3);
  m.fetchCalls[0].reject(new Error('Failed to fetch'));
  await m.harness.flush();
  eq(stateOf(m), 'error');
  eq(titleOf(m), 'Failed to fetch');
  eq(m.state.draft, '原文');
});

await check('3.10c 失败后手改草稿 → 失败态解除、图标回 idle、错误清除', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(2);
  m.fetchCalls[0].resolve({ success: false, text: '', code: 'llm_error', error: 'boom' });
  await m.harness.flush();
  eq(stateOf(m), 'error');
  m.state.draft = '原文改了一下';
  m.harness.schedule();
  await m.harness.flush(2);
  eq(stateOf(m), 'idle');
  eq(findButton(m.harness.vnode).props.title, '增强提示词');
});

await check('3.11 失败后再点 → 重新发起增强（重试语义）', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(3);
  m.fetchCalls[0].resolve({ success: false, text: '', error: '网络断开' });
  await m.harness.flush();
  eq(stateOf(m), 'error');
  await click(m); await m.harness.flush(3);
  eq(m.fetchCalls.length, 2);
  eq(stateOf(m), 'enhancing');
});

await check('调用期间用户改草稿 → 放弃写回（Latest-write guard）', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(3);
  m.state.draft = '用户改了';
  m.harness.schedule(); await m.harness.flush(3);
  m.fetchCalls[0].resolve({ success: true, text: '增强版' });
  await m.harness.flush();
  eq(m.state.draft, '用户改了');
  eq(m.setDraftCalls.length, 0);
  eq(stateOf(m), 'idle');
});

await check('3.12 停用并刷新 → 按钮消失、路由/监听/注册全部回收', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(3);
  eq(m.document.listenerCount('keydown'), 1);
  m.harness.unmount();
  eq(m.document.listenerCount('keydown'), 0, 'keydown listener leaked');
  eq(m.fetchCalls[0].aborted, true, 'in-flight request leaked on unmount');
  for (const e of m.effects) e.dispose();
  assert(m.effects.every((e) => e.disposed), 'ctx.effect disposers not invoked');
  assert(m.localeRegs.every((r) => r.disposed), 'locale dictionary not disposed');
  assert(m.slotRegs.every((r) => r.disposed), 'slot registration not disposed');
  assert(m.slotInjects.every((r) => r.disposed), 'slot inject wait not disposed');
  eq(m.document.listenerCount('keydown'), 0);
  eq(m.fetchCalls[0].aborted, true);
});

/* ------------------------------------------------------------------ */
console.log('\n阶段 5 · 回归（5.5 / 5.7）');

await check('5.5 连点 3 次 → 不产生并发写回，只有最后一次请求的结果生效', async () => {
  const m = mount({ draft: '原文' });
  await click(m); await m.harness.flush(3);           // 1st: enhancing
  await click(m); await m.harness.flush(3);           // 2nd: cancel (§3.4)
  await click(m); await m.harness.flush(3);           // 3rd: new request
  const live = m.fetchCalls.filter((c) => !c.aborted);
  eq(live.length, 1, 'exactly one request must remain live');
  // 前两次请求的结果都不得写回
  m.fetchCalls[0].resolve({ success: true, text: '第一次结果' });
  await m.harness.flush(4);
  eq(m.setDraftCalls.length, 0);
  live[0].resolve({ success: true, text: '最后一次结果' });
  await m.harness.flush();
  eq(m.state.draft, '最后一次结果');
  eq(JSON.stringify(m.setDraftCalls), JSON.stringify(['最后一次结果']));
});

await check('5.7 连续增强两次 → 第二次以当前草稿为输入，还原点更新为 增强版→二次增强版', async () => {
  const m = mount({ draft: 'A' });
  await click(m); await m.harness.flush(2);
  m.fetchCalls[0].resolve({ success: true, text: 'B' });
  await m.harness.flush();
  eq(m.state.draft, 'B');
  eq(stateOf(m), 'revert');

  // 用户手改 → 还原点失效、回 idle；再改回增强版作为第二次输入
  m.state.draft = 'B-temp'; m.harness.schedule(); await m.harness.flush();
  eq(stateOf(m), 'idle');
  m.state.draft = 'B'; m.harness.schedule(); await m.harness.flush();

  await click(m); await m.harness.flush(3);
  eq(m.fetchCalls.length, 2);
  eq(JSON.parse(m.fetchCalls[1].opts.body).text, 'B', '2nd enhancement must use current draft');
  m.fetchCalls[1].resolve({ success: true, text: 'C' });
  await m.harness.flush();
  eq(m.state.draft, 'C');
  eq(stateOf(m), 'revert');

  // 还原点应已更新为 B→C（不是 A→B）
  await click(m); await m.harness.flush();
  eq(m.state.draft, 'B');
  eq(stateOf(m), 'idle');
});

await check('5.1 草稿里的 $& / $\' / $` 原样进入请求体（函数式替换）', async () => {
  const draft = 'a $& b $\' c $` d';
  const m = mount({ draft });
  await click(m); await m.harness.flush(3);
  eq(JSON.parse(m.fetchCalls[0].opts.body).text, draft);
  m.fetchCalls[0].resolve({ success: true, text: 'ok' });
  await m.harness.flush();
  eq(m.state.draft, 'ok');
});

await check('5.3 >8000 字草稿不被截断、不预校验', async () => {
  const draft = '整理这份会议纪要并输出行动项。'.repeat(500);
  const m = mount({ draft });
  await click(m); await m.harness.flush(3);
  eq(JSON.parse(m.fetchCalls[0].opts.body).text.length, draft.length);
  m.fetchCalls[0].resolve({ success: true, text: 'ok' });
  await m.harness.flush();
});

await check('外层守卫：缺 useInput / setDraft 时返回 null，不挂 hooks', () => {
  const loaded = loadClient();
  const h = createHarness(loaded.exported.apply, null); // 占位，实际用 slot 组件
  const Component = (() => {
    let captured = null;
    const ctx = {
      effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
      locale: { register: () => () => {} },
      slots: { inject: (_n, cb) => { const d = cb(); return () => { if (typeof d === 'function') d(); }; }, register: (_o, C) => { captured = C; return () => {}; } },
    };
    loaded.exported.apply(ctx);
    return captured;
  })();
  assert(typeof Component === 'function');
  const noHooks = createHarness(Component, { inputActions: {} });
  eq(noHooks.render(), null);
  const noActions = createHarness(Component, { useInput: () => '' });
  eq(noActions.render(), null);
  assert(h !== null);
});

/* ------------------------------------------------------------------ */
console.log(`\nClient 离线测试：${passed} 通过 / ${failed} 失败`);
if (failed) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
  process.exitCode = 1;
}
