/**
 * Host half — DSH "增强提示词" plugin.
 *
 * ESM module: `export const name` + `export function apply(ctx, config)`.
 * One same-origin prefix route: POST /prompt-enhance/enhance.
 *
 * Runtime facts verified against this machine's DSH 0.2.2-rc.1 packages [A]:
 *  - `webServer.register({ kind:'prefix', path, handler })` returns a disposer.
 *  - `ctx.effect(fn, label)` returns a disposer; `ctx.inject(['webServer'], cb)`
 *    waits for a service that may mount later than this plugin.
 *  - `connection.requestRejection(req)` !== undefined means "reject" (403).
 *  - `ctx.agentDefaultModel.currentSelection()` -> { provider, model, ... }.
 *  - `ctx.llm.stream(options)` -> AsyncIterable<StreamChunk>, discriminated by
 *    `chunk.type`; a direct call is single-attempt (no automatic retry).
 *  - `GenerateOptions.system` is the one-shot system slot. `messages` is an
 *    array of DSH `Message` objects ({ id, role, content: ContentBlock[], source }),
 *    NOT `{ role, content: string }`. Adapters flatten only text blocks.
 *  - Adapter/dispatch/iteration failures surface as terminal `finish` chunks
 *    with reason.kind 'error' | 'aborted' AND may also throw from the async
 *    iterator, so both paths are handled.
 *
 * This module imports nothing from @deepseek-ai/* (those packages are not in
 * the profile's node_modules); Message objects are built by duck typing.
 */

import { SYSTEM_PROMPT, renderUserPrompt, buildMessages } from './prompt-template.mjs';

export const name = 'dsh-prompt-enhance-local';

const API_PREFIX = '/prompt-enhance';
const ENHANCE_PATH = API_PREFIX + '/enhance';
const BODY_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 300000;
const MIN_TEXT_LENGTH = 1;

const ZWSP = /[\u200B-\u200F\uFEFF]/g;
const WRAPPING_QUOTES = /^["'“”‘’]|["'“”‘’]$/g;
const FENCE_HEAD = /^```[a-zA-Z0-9_-]*\s*\n?/;
const FENCE_TAIL = /\n?```$/;
const ENHANCED_PREFIX = /^(?:Enhanced prompt|增强后的提示词|改写后的提示词|优化后的提示词)\s*[:：]\s*/i;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

class EnhanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EnhanceError';
    this.code = code;
  }
}

/** Contract: trim -> strip ZWSP -> strip fences/prefix -> strip one wrapping quote each side. */
export function cleanEnhanced(raw) {
  let text = String(raw ?? '').replace(ZWSP, '').trim();
  if (text.startsWith('```')) text = text.replace(FENCE_HEAD, '').replace(FENCE_TAIL, '').trim();
  text = text.replace(ENHANCED_PREFIX, '').trim();
  text = text.replace(WRAPPING_QUOTES, '').trim();
  return text;
}

const ok = (text) => ({ success: true, text });
const fail = (code, error) => ({ success: false, text: '', code, error });

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new EnhanceError('bad_request', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Tolerate both the ctx.get() and the property face of DSH services. */
function serviceOf(ctx, service) {
  try {
    const value = typeof ctx?.get === 'function' ? ctx.get(service) : undefined;
    if (value !== undefined && value !== null) return value;
  } catch { /* fall through to the property face */ }
  return ctx?.[service] ?? null;
}

function headerValue(req, name) {
  const raw = req?.headers?.[name];
  if (Array.isArray(raw)) return String(raw[0] ?? '');
  return raw === undefined || raw === null ? '' : String(raw);
}

/**
 * Conservative supplementary fence. The authoritative check is
 * `connection.requestRejection(req)`; this only rejects a request when there is
 * explicit evidence of a cross-site origin. A loopback Electron renderer sends
 * either no Origin or a loopback Origin, so it is never falsely rejected.
 */
function isObviouslyCrossSite(req) {
  const site = headerValue(req, 'sec-fetch-site').toLowerCase().trim();
  if (site === 'cross-site') return true; // hard evidence, regardless of Origin
  const origin = headerValue(req, 'origin').trim();
  if (!origin || origin.toLowerCase() === 'null') return false;
  try {
    const url = new URL(origin);
    // Opaque origins (file:, app:, custom Electron schemes) carry no host we
    // can judge; leave them to the host's authoritative connection fence.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (!host) return false;
    if (LOOPBACK_HOSTS.has(host)) return false;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
    return true; // explicit non-loopback http(s) Origin
  } catch {
    return true; // malformed Origin is suspicious -> fail closed
  }
}

function resolveSelection(ctx) {
  const service = serviceOf(ctx, 'agentDefaultModel');
  let selection;
  try {
    selection = service?.currentSelection?.();
  } catch {
    return null;
  }
  if (!selection?.provider || !selection?.model) return null;
  return selection;
}

/**
 * Single-attempt, out-of-band model call. Never touches the agent loop, never
 * registers a tool, never writes to a session transcript.
 *
 * `options` deliberately fills only provider/model/system/messages/signal:
 * no temperature, no maxTokens, no reasoningEffort (HANDOFF §5.3).
 */
async function callModel(ctx, { selection, draft, signal }) {
  const llm = serviceOf(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') {
    throw new EnhanceError('llm_unavailable', 'llm service is unavailable');
  }
  const { system, messages } = buildMessages(draft);
  const options = {
    provider: selection.provider,
    model: selection.model,
    system,
    messages,
    signal,
  };
  let text = '';
  try {
    for await (const chunk of llm.stream(options)) {
      if (chunk?.type === 'text-delta') {
        text += chunk.text ?? '';
      } else if (chunk?.type === 'finish') {
        const reason = chunk?.reason;
        const kind = reason?.kind;
        if (kind === 'error' || kind === 'aborted') {
          const detail = reason?.failure?.message;
          throw new EnhanceError('llm_error', `LLM stream ${kind}${detail ? `: ${detail}` : ''}`);
        }
      }
    }
  } catch (error) {
    if (error instanceof EnhanceError) throw error;
    throw new EnhanceError('llm_error', error instanceof Error ? error.message : String(error));
  }
  return text;
}

async function enhanceCore(ctx, { text, signal, timeoutMs }) {
  const draft = typeof text === 'string' ? text : '';
  // Empty input must not consume a model call (ACCEPTANCE 2.2).
  if (draft.replace(ZWSP, '').trim().length < MIN_TEXT_LENGTH) {
    return fail('empty_input', 'Empty input');
  }
  const selection = resolveSelection(ctx);
  if (!selection) return fail('llm_unavailable', 'No model route (agentDefaultModel) available');

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const raw = await callModel(ctx, { selection, draft, signal: controller.signal });
    const enhanced = cleanEnhanced(raw);
    return enhanced ? ok(enhanced) : fail('llm_error', 'Enhanced result is empty');
  } catch (error) {
    if (signal?.aborted) return fail('llm_error', 'Request aborted');
    if (controller.signal.aborted) return fail('llm_error', `Request timed out after ${timeoutMs}ms`);
    return fail(error?.code ?? 'unknown', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * One same-origin prefix route. HTTP status is 200 for every business outcome
 * (success:false carries the failure); only protocol/gate errors use 4xx/5xx.
 */
export async function handleEnhanceRequest(ctx, req, res, config = {}) {
  const connection = serviceOf(ctx, 'connection');
  if (!connection || typeof connection.requestRejection !== 'function') {
    // Fail closed: without the host's connection fence we cannot authenticate.
    return writeJson(res, 503, fail('forbidden', 'connection fence is unavailable'));
  }
  let rejection;
  try {
    rejection = connection.requestRejection(req);
  } catch {
    rejection = true; // a thrown fence is a rejected request, not a bypass
  }
  if (rejection !== undefined || isObviouslyCrossSite(req)) {
    return writeJson(res, 403, fail('forbidden', 'Cross-origin request rejected'));
  }
  if (req.method !== 'POST') return writeJson(res, 405, fail('method_not_allowed', 'POST required'));
  if (!String(req.url ?? '').split('?')[0].endsWith('/enhance')) {
    return writeJson(res, 404, fail('not_found', 'Unknown method'));
  }
  if (config.enabled === false) return writeJson(res, 409, fail('disabled', 'Plugin disabled'));

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return writeJson(res, 400, fail('bad_request', error instanceof Error ? error.message : 'Invalid JSON'));
  }

  const abort = new AbortController();
  // IncomingMessage 'close' also fires on a normally completed request, which
  // would abort the model call mid-flight. Watch the *response* instead, and
  // only abort when the peer went away before we finished writing.
  if (typeof res?.on === 'function') {
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
  }
  const result = await enhanceCore(ctx, {
    text: typeof payload?.text === 'string' ? payload.text : '',
    signal: abort.signal,
    timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS,
  });
  return writeJson(res, 200, result);
}

/**
 * [A] Pattern copied from the installed dsh-client-ui-quote host half.
 * Every registration is reversible via ctx.effect(); disabling the plugin
 * removes the route, and no listeners survive.
 */
// A WeakSet keyed by host context makes apply() idempotent even when cordis
// re-enters apply() on the same ctx (HMR, duplicate activation). Entries are
// removed by the effect disposer so disabling and re-enabling registers again.
const installedContexts = new WeakSet();

export function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.effect !== 'function') return;
  const pluginConfig = config && typeof config === 'object' ? config : {};
  let installed = false;
  const install = (hostCtx) => {
    const tracked = hostCtx && typeof hostCtx === 'object';
    if (installed || (tracked && installedContexts.has(hostCtx))) return;
    const webServer = serviceOf(hostCtx, 'webServer');
    if (!webServer || typeof webServer.register !== 'function') return;
    installed = true;
    if (tracked) installedContexts.add(hostCtx);
    hostCtx.effect(() => {
      let dispose = () => {};
      try {
        dispose = webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: (req, res) => {
            void handleEnhanceRequest(hostCtx, req, res, pluginConfig).catch((error) => {
              writeJson(res, 200, fail('unknown', error instanceof Error ? error.message : String(error)));
            });
          },
        });
      } catch (error) {
        if (tracked) installedContexts.delete(hostCtx);
        installed = false;
        console.warn('[prompt-enhance] route registration failed:', error);
        return () => {};
      }
      return () => {
        if (tracked) installedContexts.delete(hostCtx);
        try { if (typeof dispose === 'function') dispose(); } catch { /* host is tearing down */ }
      };
    }, 'prompt-enhance: enhance API');
  };

  if (typeof ctx.inject === 'function' && typeof ctx.get === 'function') {
    try {
      ctx.inject(['webServer'], install);
      return;
    } catch { /* fall through to direct lookup */ }
  }
  install(ctx);
}

/** Offline unit tests can drive these without booting DSH. */
export const __testing = {
  API_PREFIX,
  ENHANCE_PATH,
  cleanEnhanced,
  buildMessages,
  renderUserPrompt,
  SYSTEM_PROMPT,
  isObviouslyCrossSite,
  enhanceCore,
  handleEnhanceRequest,
};
