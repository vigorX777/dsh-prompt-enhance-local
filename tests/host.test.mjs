/**
 * 离线测试 · Host 半（ESM，直接导入成品包，不启动 DSH）
 *
 * 覆盖 ACCEPTANCE.md 阶段 0（纯函数基线 13 项）、阶段 2（Host 8 项 2.1–2.8）、
 * 阶段 3 的 3.12 停用回收（Host 侧）、阶段 5 的 5.1/5.3 回归。
 *
 * 运行：node tests/host.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = ROOT;

const host = await import(path.join(BUNDLE, 'index.js'));
const tpl = await import(path.join(BUNDLE, 'prompt-template.mjs'));
const {
  API_PREFIX, ENHANCE_PATH, cleanEnhanced, buildMessages, renderUserPrompt,
  SYSTEM_PROMPT, isObviouslyCrossSite, enhanceCore, handleEnhanceRequest,
} = { ...host.__testing, ...host };

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
    console.log(`  FAIL  ${name}\n        ${error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n        ') : error}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'not equal'}: expected ${b}, got ${a}`);
}

/* ------------------------------------------------------------------ */
/* mock ctx / req / res                                               */
/* ------------------------------------------------------------------ */

function makeCtx(overrides = {}) {
  const captured = { options: null, streamCalls: 0 };
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'magpie', model: 'workbuddy/hy4free' }) },
    llm: {
      stream(options) {
        captured.streamCalls++;
        captured.options = options;
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '"Hello world"' };
          yield { type: 'finish', index: 0, reason: { kind: 'stop' } };
        })();
      },
    },
    connection: { requestRejection: () => undefined },
    ...overrides.services,
  };
  const effects = [];
  const routes = [];
  const ctx = {
    get(name) { return services[name]; },
    inject(names, cb) { ctx._injected = names; cb(ctx); },
    effect(fn, label) {
      const cleanup = fn();
      const rec = { label, cleanup, disposed: false };
      // The disposer returned by ctx.effect is what cordis invokes on teardown.
      // Expose THAT as rec.dispose so tests exercise the real teardown path.
      rec.dispose = () => {
        if (!rec.disposed) {
          rec.disposed = true;
          if (typeof cleanup === 'function') cleanup();
        }
      };
      effects.push(rec);
      return rec.dispose;
    },
    webServer: {
      register(opts) {
        const rec = { ...opts, disposed: false };
        routes.push(rec);
        return () => { rec.disposed = true; };
      },
    },
  };
  // serviceOf 会先试 ctx.get()，再退回属性面；webServer 放属性面即可
  services.webServer = ctx.webServer;
  return { ctx, captured, effects, routes, services };
}

function makeReq({ method = 'POST', url = ENHANCE_PATH, headers = {}, body = '{}', chunks = null } = {}) {
  const handlers = {};
  const pieces = chunks === null ? [Buffer.from(body)] : chunks.map((c) => Buffer.from(c));
  const req = {
    method, url, headers, destroyed: false,
    on(ev, fn) {
      (handlers[ev] ||= []).push(fn);
      if (ev === 'end') {
        queueMicrotask(() => {
          for (const p of pieces) for (const fn of handlers.data || []) fn(p);
          for (const fn of handlers.end || []) fn();
        });
      }
      return req;
    },
    destroy() { req.destroyed = true; },
  };
  return req;
}

function makeRes() {
  const handlers = {};
  const res = {
    statusCode: 0, headers: null, payload: null, writableEnded: false,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; return res; },
    end(payload) { res.payload = payload; res.writableEnded = true; return res; },
    on(ev, fn) { (handlers[ev] ||= []).push(fn); return res; },
    emitClose() { for (const fn of handlers.close || []) fn(); },
  };
  return res;
}

function parsed(res) {
  return JSON.parse(res.payload);
}
async function request(ctx, reqInit, config = {}, res = makeRes()) {
  const req = makeReq(reqInit);
  await handleEnhanceRequest(ctx, req, res, config);
  return { res, body: parsed(res), req };
}

/* ------------------------------------------------------------------ */
/* 阶段 0 · 纯函数基线                                                */
/* ------------------------------------------------------------------ */
console.log('\n阶段 0 · 纯函数基线');

await check('双层模板：system 定义角色/红线，user 下发语言一致性与反例，原文完整注入', () => {
  assert(SYSTEM_PROMPT.includes('prompt engineering specialist'));
  assert(SYSTEM_PROMPT.includes('HIGHEST PRIORITY - LANGUAGE'));
  assert(SYSTEM_PROMPT.includes('Do NOT answer the request'));
  assert(tpl.USER_TEMPLATE.includes('BAD OUTPUT'));
  assert(tpl.SYSTEM_PROMPT === SYSTEM_PROMPT);
  const draft = '帮我看看这段 SQL';
  assert(renderUserPrompt(draft).includes(draft));
});

await check('函数式替换：草稿里的 $& / $\' / $` 按字面量保留，不被展开', () => {
  const draft = 'price $& then $\' and $` end';
  const rendered = renderUserPrompt(draft);
  assert(rendered.includes(draft), `literal draft missing: ${rendered.slice(0, 200)}`);
  assert(!rendered.includes('USER DRAFT: price USER DRAFT:'), 'replacement pattern leaked');
});

await check('cleanEnhanced：剥首尾各一个中英包裹引号（""x"" → "x"）', () => {
  eq(cleanEnhanced('"hello"'), 'hello');
  eq(cleanEnhanced('""hello""'), '"hello"');
  eq(cleanEnhanced('“你好”'), '你好');
});

await check('cleanEnhanced：兜底剥整段代码围栏与 Enhanced prompt: / 优化后的提示词： 前缀', () => {
  eq(cleanEnhanced('```python\nprint(1)\n```'), 'print(1)');
  eq(cleanEnhanced('```\nhello\n```'), 'hello');
  eq(cleanEnhanced('Enhanced prompt: hello'), 'hello');
  eq(cleanEnhanced('优化后的提示词：你好'), '你好');
  eq(cleanEnhanced('```md\nEnhanced prompt: hello\n```'), 'hello');
});

await check('cleanEnhanced：去零宽字符 \\u200B-\\u200F / \\uFEFF', () => {
  eq(cleanEnhanced('\u200B\uFEFFhello\u200C'), 'hello');
  eq(cleanEnhanced('  \u200B  '), '');
});

await check('cleanEnhanced：后处理顺序固定（trim→零宽→围栏/前缀→包裹引号）', () => {
  eq(cleanEnhanced('  \u200B```\nEnhanced prompt: "hi"\n```  '), 'hi');
  // Known limit of the FIXED order: prefix runs BEFORE quote strip. When a
  // label is quoted inside the wrapper it cannot be matched by ^label regex.
  // Record it rather than pretend the contract strips it.
  eq(cleanEnhanced('"Enhanced prompt: hi"'), 'Enhanced prompt: hi');
});

await check('buildMessages：返回 {system, messages:[DSH Message]}，system 不在 messages 里', () => {
  const { system, messages } = buildMessages('写个排序函数');
  eq(system, SYSTEM_PROMPT);
  eq(messages.length, 1);
  const m = messages[0];
  eq(m.role, 'user');
  eq(m.source.kind, 'user');
  assert(Array.isArray(m.content), 'content must be ContentBlock[]');
  eq(m.content[0].type, 'text');
  assert(m.content[0].text.includes('写个排序函数'));
  assert(!messages.some((x) => x.role === 'system'), 'system must NOT be inside messages');
});

await check('buildMessages：用函数式替换，草稿里的 $& 原样进入 text block', () => {
  const { messages } = buildMessages('a $& b');
  assert(messages[0].content[0].text.includes('a $& b'));
});

await check('GenerateOptions 形状：只填 provider/model/system/messages/signal', async () => {
  const { ctx, captured } = makeCtx();
  await enhanceCore(ctx, { text: 'hello', timeoutMs: 5000 });
  const o = captured.options;
  assert(o, 'stream was not called');
  eq(o.provider, 'magpie');
  eq(o.model, 'workbuddy/hy4free');
  eq(o.system, SYSTEM_PROMPT);
  eq(o.messages.length, 1);
  assert('signal' in o);
  for (const forbidden of ['temperature', 'maxTokens', 'reasoningEffort', 'tools', 'stop', 'purpose']) {
    assert(!(forbidden in o), `GenerateOptions must not carry ${forbidden}`);
  }
});

await check('空输入短路：empty_input 且不发起模型调用（ACCEPTANCE 2.2）', async () => {
  const { ctx, captured } = makeCtx();
  const r = await enhanceCore(ctx, { text: '   \n \u200B ', timeoutMs: 5000 });
  deepEq(r, { success: false, text: '', code: 'empty_input', error: 'Empty input' });
  eq(captured.streamCalls, 0);
});

await check('缺少模型路由：llm_unavailable，text 恒为空串', async () => {
  const { ctx, captured } = makeCtx({ services: { agentDefaultModel: null } });
  const r = await enhanceCore(ctx, { text: 'hello', timeoutMs: 5000 });
  eq(r.success, false);
  eq(r.code, 'llm_unavailable');
  eq(r.text, '');
  eq(captured.streamCalls, 0);
});

await check('缺少 llm 服务：llm_unavailable，text 恒为空串', async () => {
  const { ctx } = makeCtx({ services: { llm: null } });
  const r = await enhanceCore(ctx, { text: 'hello', timeoutMs: 5000 });
  eq(r.code, 'llm_unavailable');
  eq(r.text, '');
});

await check('成功路径：固定信封 {success:true,text} 且已清洗', async () => {
  const { ctx } = makeCtx();
  const r = await enhanceCore(ctx, { text: 'hello', timeoutMs: 5000 });
  deepEq(r, { success: true, text: 'Hello world' });
});

await check('finish chunk error/aborted → llm_error，并带 failure.message', async () => {
  const { ctx } = makeCtx({
    services: {
      llm: {
        stream: () => (async function* () {
          yield { type: 'finish', index: 0, reason: { kind: 'error', failure: { message: 'rate limited (429)' } } };
        })(),
      },
    },
  });
  const r = await enhanceCore(ctx, { text: 'hello', timeoutMs: 5000 });
  eq(r.success, false);
  eq(r.code, 'llm_error');
  eq(r.text, '');
  assert(r.error.includes('rate limited (429)'), `error should carry failure.message: ${r.error}`);
});

await check('迭代器抛错 → llm_error（与 finish chunk 两条路径都覆盖）', async () => {
  const { ctx } = makeCtx({
    services: {
      llm: { stream: () => (async function* () { throw new Error('ECONNRESET'); })() },
    },
  });
  const r = await enhanceCore(ctx, { text: 'hello', timeoutMs: 5000 });
  eq(r.code, 'llm_error');
  eq(r.text, '');
  assert(r.error.includes('ECONNRESET'));
});

await check('产出空白 → llm_error / Enhanced result is empty（2.7）', async () => {
  const { ctx } = makeCtx({
    services: {
      llm: { stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: '  ```  ' }; })() },
    },
  });
  const r = await enhanceCore(ctx, { text: 'hello', timeoutMs: 5000 });
  eq(r.code, 'llm_error');
  eq(r.error, 'Enhanced result is empty');
  eq(r.text, '');
});

await check('超时 → llm_error / Request timed out …，不挂死（2.8）', async () => {
  const { ctx } = makeCtx({
    services: {
      llm: {
        stream: (options) => (async function* () {
          await new Promise((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener('abort', resolve, { once: true });
          });
          throw new Error('stream interrupted');
        })(),
      },
    },
  });
  const started = Date.now();
  const r = await enhanceCore(ctx, { text: 'hello', timeoutMs: 25 });
  eq(r.code, 'llm_error');
  eq(r.text, '');
  assert(r.error.startsWith('Request timed out after 25ms'), `got: ${r.error}`);
  assert(Date.now() - started < 2000, 'timeout did not resolve promptly');
});

await check('外部 signal abort → llm_error / Request aborted', async () => {
  const { ctx } = makeCtx({
    services: {
      llm: {
        stream: (options) => (async function* () {
          await new Promise((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener('abort', resolve, { once: true });
          });
          throw new Error('stream interrupted');
        })(),
      },
    },
  });
  const ac = new AbortController();
  const p = enhanceCore(ctx, { text: 'hello', signal: ac.signal, timeoutMs: 5000 });
  ac.abort();
  const r = await p;
  eq(r.code, 'llm_error');
  eq(r.error, 'Request aborted');
});

/* ------------------------------------------------------------------ */
/* 阶段 2 · Host HTTP 契约                                            */
/* ------------------------------------------------------------------ */
console.log('\n阶段 2 · Host HTTP 契约');

await check('2.1 POST /prompt-enhance/enhance → 200 固定信封 + 清洗后正文', async () => {
  const { ctx } = makeCtx();
  const { res, body } = await request(ctx, { body: JSON.stringify({ text: '优化一下' }) });
  eq(res.statusCode, 200);
  eq(res.headers['content-type'], 'application/json; charset=utf-8');
  deepEq(body, { success: true, text: 'Hello world' });
});

await check('2.2 空 text → 200 / empty_input，模型调用计数不增加', async () => {
  const { ctx, captured } = makeCtx();
  const { body } = await request(ctx, { body: JSON.stringify({ text: '   \n ' }) });
  eq(body.code, 'empty_input');
  eq(body.text, '');
  eq(captured.streamCalls, 0);
});

await check('2.3 非 POST → 405 method_not_allowed', async () => {
  const { ctx } = makeCtx();
  const { res, body } = await request(ctx, { method: 'GET' });
  eq(res.statusCode, 405);
  eq(body.code, 'method_not_allowed');
  eq(body.text, '');
});

await check('2.4 坏 JSON → 400 bad_request', async () => {
  const { ctx } = makeCtx();
  const { res, body } = await request(ctx, { body: '{not json' });
  eq(res.statusCode, 400);
  eq(body.code, 'bad_request');
  eq(body.text, '');
});

await check('2.5 伪造 Origin / cross-site → 403 forbidden', async () => {
  const { ctx } = makeCtx();
  for (const headers of [
    { origin: 'https://evil.example.com' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'bogus-value', origin: 'https://evil.example.com' },
    { origin: 'not-a-url' },
  ]) {
    const { res, body } = await request(ctx, { headers });
    eq(res.statusCode, 403, `headers=${JSON.stringify(headers)}`);
    eq(body.code, 'forbidden');
    eq(body.text, '');
  }
});

await check('2.5b 同源/loopback/opaque Origin 不误伤', () => {
  assert(isObviouslyCrossSite(makeReq({ headers: {} })) === false);
  assert(isObviouslyCrossSite(makeReq({ headers: { origin: 'http://127.0.0.1:62285' } })) === false);
  assert(isObviouslyCrossSite(makeReq({ headers: { origin: 'http://localhost:62285' } })) === false);
  assert(isObviouslyCrossSite(makeReq({ headers: { origin: 'null' } })) === false);
  assert(isObviouslyCrossSite(makeReq({ headers: { origin: 'file:///app' } })) === false);
  assert(isObviouslyCrossSite(makeReq({ headers: { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:62285' } })) === false);
  assert(isObviouslyCrossSite(makeReq({ headers: { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:62285' } })) === true);
});

await check('2.5c connection.requestRejection 非 undefined / 抛错 → 403（fail closed）', async () => {
  const { ctx } = makeCtx();
  ctx.get = ((orig) => (name) => {
    if (name === 'connection') return { requestRejection: () => 'reject' };
    return orig(name);
  })(ctx.get);
  const a = await request(ctx, {});
  eq(a.res.statusCode, 403);

  const { ctx: ctx2 } = makeCtx();
  ctx2.get = ((orig) => (name) => {
    if (name === 'connection') return { requestRejection: () => { throw new Error('fence down'); } };
    return orig(name);
  })(ctx2.get);
  const b = await request(ctx2, {});
  eq(b.res.statusCode, 403);
});

await check('2.5d connection 服务缺席 → 503（fail closed，不静默放行）', async () => {
  const { ctx } = makeCtx({ services: { connection: null } });
  const { res, body } = await request(ctx, {});
  eq(res.statusCode, 503);
  eq(body.code, 'forbidden');
});

await check('2.6 断网（llm 抛错）→ llm_error，text 恒为空串', async () => {
  const { ctx } = makeCtx({
    services: { llm: { stream: () => (async function* () { throw new Error('network down'); })() } },
  });
  const { res, body } = await request(ctx, { body: JSON.stringify({ text: 'x' }) });
  eq(res.statusCode, 200);
  eq(body.code, 'llm_error');
  eq(body.text, '');
});

await check('2.6b 无效模型路由 → llm_unavailable，text 恒为空串', async () => {
  const { ctx } = makeCtx({ services: { agentDefaultModel: { currentSelection: () => ({}) } } });
  const { body } = await request(ctx, { body: JSON.stringify({ text: 'x' }) });
  eq(body.code, 'llm_unavailable');
  eq(body.text, '');
});

await check('2.7 模型返回空 → llm_error / Enhanced result is empty', async () => {
  const { ctx } = makeCtx({
    services: { llm: { stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: '' }; })() } },
  });
  const { body } = await request(ctx, { body: JSON.stringify({ text: 'x' }) });
  eq(body.code, 'llm_error');
  eq(body.error, 'Enhanced result is empty');
  eq(body.text, '');
});

await check('2.8 超时 → llm_error / Request timed out …，HTTP 仍 200 且不挂死', async () => {
  const { ctx } = makeCtx({
    services: {
      llm: {
        stream: (options) => (async function* () {
          await new Promise((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener('abort', resolve, { once: true });
          });
          throw new Error('interrupted');
        })(),
      },
    },
  });
  const { res, body } = await request(ctx, { body: JSON.stringify({ text: 'x' }) }, { timeoutMs: 25 });
  eq(res.statusCode, 200);
  eq(body.code, 'llm_error');
  assert(body.error.startsWith('Request timed out after 25ms'));
  eq(body.text, '');
});

await check('无效路由（prefix 下非 /enhance）→ 404 not_found', async () => {
  const { ctx } = makeCtx();
  const { res, body } = await request(ctx, { url: '/prompt-enhance/other' });
  eq(res.statusCode, 404);
  eq(body.code, 'not_found');
});

await check('config.enabled === false → 409 disabled', async () => {
  const { ctx } = makeCtx();
  const { res, body } = await request(ctx, { body: JSON.stringify({ text: 'x' }) }, { enabled: false });
  eq(res.statusCode, 409);
  eq(body.code, 'disabled');
});

await check('请求体超过 BODY_LIMIT → 400 bad_request（5.3 边界）', async () => {
  const { ctx } = makeCtx();
  const huge = 'x'.repeat(300 * 1024);
  const { res, body, req } = await request(ctx, { body: JSON.stringify({ text: huge }) });
  eq(res.statusCode, 400);
  eq(body.code, 'bad_request');
  assert(req.destroyed, 'oversized request should be destroyed');
});

await check('5.3 >8000 字草稿不截断、不预校验，完整送进 messages', async () => {
  const long = '整理这份会议纪要并输出行动项。'.repeat(500); // > 8000 chars
  const { ctx, captured } = makeCtx();
  const { body } = await request(ctx, { body: JSON.stringify({ text: long }) });
  eq(body.success, true);
  assert(captured.options.messages[0].content[0].text.includes(long), 'draft was truncated');
});

await check('客户端断开（res close 未完成）→ abort 在途请求，返回 Request aborted', async () => {
  const { ctx } = makeCtx({
    services: {
      llm: {
        stream: (options) => (async function* () {
          await new Promise((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener('abort', resolve, { once: true });
          });
          throw new Error('interrupted');
        })(),
      },
    },
  });
  const res = makeRes();
  const req = makeReq({ body: JSON.stringify({ text: 'x' }) });
  const p = handleEnhanceRequest(ctx, req, res, {});
  await new Promise((r) => setImmediate(r));
  res.emitClose();
  await p;
  eq(parsed(res).code, 'llm_error');
  eq(parsed(res).error, 'Request aborted');
});

/* ------------------------------------------------------------------ */
/* 3.12 停用回收（Host 侧）                                           */
/* ------------------------------------------------------------------ */
console.log('\n阶段 3 · 停用回收（Host 侧）');

await check('apply 用 ctx.inject([webServer]) + ctx.effect 注册 prefix 路由', () => {
  const { ctx, routes, effects } = makeCtx();
  host.apply(ctx, {});
  deepEq(ctx._injected, ['webServer']);
  eq(routes.length, 1);
  eq(routes[0].kind, 'prefix');
  eq(routes[0].path, API_PREFIX);
  eq(effects.length, 1);
  eq(effects[0].label, 'prompt-enhance: enhance API');
});

await check('apply 幂等：重复调用不重复注册', () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx, {});
  host.apply(ctx, {});
  eq(routes.length, 1);
});

await check('停用（effect disposer）→ 路由被移除，无残留在途注册', () => {
  const { ctx, routes, effects } = makeCtx();
  host.apply(ctx, {});
  eq(routes[0].disposed, false);
  effects[0].dispose();
  eq(routes[0].disposed, true);
  eq(effects[0].disposed, true);
});

await check('apply 在 ctx 缺少 effect 时静默不炸', () => {
  host.apply({}, {});
  host.apply(null, {});
});

await check('apply 支持属性面 ctx（无 inject）直接注册', () => {
  const { ctx, routes } = makeCtx();
  const bare = { get: ctx.get, effect: ctx.effect, webServer: ctx.webServer };
  host.apply(bare, {});
  eq(routes.length, 1);
});

await check('模块导出形态：ESM apply + name，无 CommonJS 泄漏', () => {
  eq(typeof host.apply, 'function');
  eq(host.name, 'dsh-prompt-enhance-local');
  eq(typeof host.__testing, 'object');
});

/* ------------------------------------------------------------------ */
console.log(`\nHost 离线测试：${passed} 通过 / ${failed} 失败`);
if (failed) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
  process.exitCode = 1;
}
