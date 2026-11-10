/**
 * Client half — DSH "增强提示词" plugin.
 *
 * Bundle format [A]: the official DSH client-bundle shape is a lazy-CJS
 * closure registered with window.__ModuleLoader__.load({ id, factory }).
 * `react` is an external resolved from the shell's module table at runtime;
 * everything else is inlined. DSH does NOT wrap a bare `module.exports` file,
 * so the wrapper is written by hand here (no build step). The `id` equals the
 * package name, matching the cordis.patch.yml row name.
 *
 * Keeps factories free of side effects: locale dictionaries, the slot
 * registration and any listeners live inside `apply` / `ctx.effect` / React
 * effects and all return their cleanup. Disabling the plugin removes them.
 *
 * Four-state machine [HANDOFF §3.4]:
 *   idle      ✨ 增强提示词    -> trigger
 *   enhancing rotating spinner -> cancel the in-flight fetch (draft untouched)
 *   revert    ↩ 恢复原文       -> setDraft(original) and invalidate the point
 *   error     ⚠ 增强失败       -> retry, title carries the error text
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhance-local',
  factory: (require) => {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var useCallback = React.useCallback;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useState = React.useState;

    var NS = 'prompt-enhance';
    var ENDPOINT = '/prompt-enhance/enhance';
    var ZWSP = /[\u200B-\u200F\uFEFF]/g;
    var MIN_TEXT_LENGTH = 1;

    // Runtime dictionaries for the Client locale service. The locale/*.json
    // files carry Plugin Manager metadata (meta.title / meta.description) and
    // are a separate, host-side concern.
    var DICT = {
      zh: {
        enhance: '增强提示词',
        enhancing: '增强中…（点击取消）',
        revert: '恢复原文',
        failed: '增强失败',
      },
      en: {
        enhance: 'Enhance prompt',
        enhancing: 'Enhancing… (click to cancel)',
        revert: 'Restore original',
        failed: 'Enhance failed',
      },
    };

    function translate(key) {
      var lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh';
      var table = String(lang).toLowerCase().indexOf('zh') === 0 ? DICT.zh : DICT.en;
      return table[key] || (DICT.zh[key] || key);
    }

    function hasEnhanceableText(draft) {
      return String(draft == null ? '' : draft).replace(ZWSP, '').trim().length >= MIN_TEXT_LENGTH;
    }

    function labelOf(props, key) {
      var t = props && typeof props.t === 'function' ? props.t : null;
      if (t) {
        var value = t(key);
        if (typeof value === 'string' && value && value !== key) return value;
      }
      return translate(key); // module-level fallback (correct for a zh reader)
    }

    // Component-local styles: rendered as React elements so unmounting removes
    // them. Theme tokens come from the host; fallbacks are `inherit`/`currentColor`,
    // never a hard-coded brand color.
    var STYLE_TEXT = [
      '@keyframes prompt-enhance-spin{to{transform:rotate(360deg)}}',
      '@keyframes prompt-enhance-pop{0%{opacity:.35;transform:scale(.7)}100%{opacity:1;transform:scale(1)}}',
      '.dsh-pe-btn{transition:color .15s ease,background-color .15s ease}',
      '.dsh-pe-btn:hover{color:var(--dsw-alias-link-normal,currentColor)}',
      '.dsh-pe-btn:focus-visible{outline:2px solid var(--dsw-alias-link-normal,currentColor);outline-offset:2px}',
      '.dsh-pe-icon{animation:prompt-enhance-pop .16s ease-out}',
      '.dsh-pe-spin{animation:prompt-enhance-spin .9s linear infinite!important}',
      '@media (prefers-reduced-motion: reduce){.dsh-pe-icon,.dsh-pe-spin{animation:none!important}}',
    ].join('');

    /**
     * Four-state icons, inlined as SVG from Lucide (https://lucide.dev, ISC
     * License). The bundle may only `require('react')` at runtime, so a mature
     * icon package cannot be imported — we inline the path data instead. Icons
     * use `stroke: currentColor`, so they inherit the themed button color.
     */
    var ICON_PATHS = {
      sparkles: [
        ['path', { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z' }],
        ['path', { d: 'M20 3v4' }],
        ['path', { d: 'M22 5h-4' }],
        ['path', { d: 'M4 17v2' }],
        ['path', { d: 'M5 18H3' }],
      ],
      loader: [
        ['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }],
      ],
      undo: [
        ['path', { d: 'M9 14 4 9l5-5' }],
        ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11' }],
      ],
      alert: [
        ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
        ['path', { d: 'M12 9v4' }],
        ['path', { d: 'M12 17h.01' }],
      ],
    };
    var STATUS_ICON = { idle: 'sparkles', enhancing: 'loader', revert: 'undo', error: 'alert' };

    function renderIcon(status, spinning) {
      var paths = ICON_PATHS[STATUS_ICON[status] || 'sparkles'];
      var children = paths.map(function (entry) { return React.createElement(entry[0], entry[1]); });
      var className = spinning ? 'dsh-pe-icon dsh-pe-spin' : 'dsh-pe-icon';
      return React.createElement.apply(React, ['svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className: className,
      }].concat(children));
    }

    /**
     * Outer component guards the standard slot props before mounting the
     * hook-bearing inner component, so React hook order stays stable.
     * [A] `conversation.input.right` is a session-scoped list slot; the host
     * merges SessionStandardProps (useInput / inputActions / sessionId) and,
     * because we register with `locale: NS`, injects `t` into props.
     */
    function EnhanceButton(props) {
      var source = props || {};
      var useInput = source.useInput;
      var inputActions = source.inputActions;
      if (typeof useInput !== 'function' || !inputActions || typeof inputActions.setDraft !== 'function') {
        return null;
      }
      return React.createElement(EnhanceButtonInner, source);
    }

    function EnhanceButtonInner(props) {
      var useInput = props.useInput;
      var inputActions = props.inputActions;
      var sessionId = props.sessionId;

      var draft = useInput(function (state) { return String((state && state.draft) || ''); });
      var latestDraft = useRef(draft);
      latestDraft.current = draft;

      var state = useState('idle'); // idle | enhancing | revert | error
      var status = state[0];
      var setStatus = state[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var backupRef = useRef(null);     // text before the last successful enhancement
      var appliedRef = useRef(null);    // text written back by that enhancement
      var controllerRef = useRef(null); // the only in-flight AbortController
      var errorDraftRef = useRef(null);  // draft that produced the current error

      var clearRestorePoint = useCallback(function () {
        backupRef.current = null;
        appliedRef.current = null;
      }, []);

      var cancel = useCallback(function () {
        if (controllerRef.current) controllerRef.current.abort();
        controllerRef.current = null;
        errorDraftRef.current = null;
        setStatus('idle');
        setError(null);
      }, []);

      var revert = useCallback(function () {
        // 3.7: a manual edit invalidates the restore point; never overwrite it.
        if (appliedRef.current === null || latestDraft.current !== appliedRef.current) {
          clearRestorePoint();
          setStatus('idle');
          setError(null);
          return;
        }
        if (backupRef.current === null) {
          clearRestorePoint();
          setStatus('idle');
          return;
        }
        inputActions.setDraft(backupRef.current);
        clearRestorePoint();
        setStatus('idle');
        setError(null);
      }, [inputActions, clearRestorePoint]);

      var trigger = useCallback(async function () {
        // Last-write-wins for rapid consecutive clicks (ACCEPTANCE 5.5): abort
        // the previous request before starting a new one. The old request's
        // aborted signal prevents it from writing back.
        if (controllerRef.current) controllerRef.current.abort();
        var sent = latestDraft.current;
        if (!hasEnhanceableText(sent)) return;
        var controller = new AbortController();
        controllerRef.current = controller;
        setStatus('enhancing');
        setError(null);
        try {
          var response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: sent }),
            signal: controller.signal,
          });
          var result = await response.json();
          if (controller.signal.aborted) return;
          if (!result || !result.success) {
            errorDraftRef.current = sent;
            setStatus('error');
            setError((result && result.error) || labelOf(props, 'failed'));
            return; // failure never touches the draft
          }
          // The user typed while the request was in flight -> discard the write-back.
          if (latestDraft.current !== sent) {
            if (controllerRef.current === controller) setStatus('idle');
            return;
          }
          errorDraftRef.current = null;
          backupRef.current = sent;
          appliedRef.current = result.text;
          inputActions.setDraft(result.text); // whole-draft replace; NEVER auto-send
          setStatus('revert');
        } catch (err) {
          if (controller.signal.aborted) return;
          errorDraftRef.current = sent;
          setStatus('error');
          // Realm-agnostic: fetch may reject with a plain object or an Error
          // from another realm, where `instanceof Error` is false.
          setError(err && typeof err.message === 'string' && err.message ? err.message : String(err));
        } finally {
          if (controllerRef.current === controller) {
            controllerRef.current = null;
          }
        }
      }, [inputActions, props]);

      var onClick = useCallback(function () {
        if (status === 'enhancing') return cancel();
        if (status === 'revert') return revert();
        return trigger();
      }, [status, cancel, revert, trigger]);

      // 3.7 / 3.5: manual edit, send-clear or external undo invalidates the point.
      useEffect(function () {
        if (appliedRef.current !== null && draft !== appliedRef.current) {
          clearRestorePoint();
          setStatus(function (prev) { return prev === 'revert' ? 'idle' : prev; });
        }
        // An error belongs to the text that caused it: once the user edits the
        // draft, drop the failed state so the icon returns to idle.
        if (errorDraftRef.current !== null && draft !== errorDraftRef.current) {
          errorDraftRef.current = null;
          setError(null);
          setStatus(function (prev) { return prev === 'error' ? 'idle' : prev; });
        }
      }, [draft, clearRestorePoint]);

      // 3.9: switching sessions resets everything (the slot is scoped to a
      // session, but this also covers a reused component instance).
      useEffect(function () {
        if (controllerRef.current) controllerRef.current.abort();
        controllerRef.current = null;
        clearRestorePoint();
        errorDraftRef.current = null;
        setStatus('idle');
        setError(null);
      }, [sessionId, clearRestorePoint]);

      // 3.5: DSH setDraft() is a history-merge Lexical edit, so native Cmd+Z
      // cannot reach the pre-enhance text. Intercept exactly one keypress.
      useEffect(function () {
        if (typeof document === 'undefined') return undefined;
        var handler = function (event) {
          if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
          if (String(event.key).toLowerCase() !== 'z') return;
          if (appliedRef.current === null || latestDraft.current !== appliedRef.current) return;
          var active = document.activeElement;
          var inComposer = active && (active.isContentEditable ||
            active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
          if (!inComposer) return;
          event.preventDefault();
          event.stopPropagation();
          revert();
        };
        document.addEventListener('keydown', handler, true);
        return function () { document.removeEventListener('keydown', handler, true); };
      }, [revert]);

      // Abort any in-flight request when the component unmounts.
      useEffect(function () {
        return function () {
          if (controllerRef.current) controllerRef.current.abort();
          controllerRef.current = null;
        };
      }, []);

      var canRender = hasEnhanceableText(draft) || status !== 'idle';
      if (!canRender) return null;

      var label = status === 'enhancing'
        ? labelOf(props, 'enhancing')
        : status === 'revert'
          ? labelOf(props, 'revert')
          : status === 'error'
            ? labelOf(props, 'failed')
            : labelOf(props, 'enhance');
      var tooltip = status === 'error' ? (error || label) : label;

      var icon = renderIcon(status, status === 'enhancing');

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('style', null, STYLE_TEXT),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-pe-btn',
            title: tooltip,
            'aria-label': label,
            'aria-busy': status === 'enhancing' ? 'true' : 'false',
            'data-state': status,
            onClick: onClick,
            style: {
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, padding: 0, border: 'none', borderRadius: 8,
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, inherit)',
              cursor: 'pointer', fontSize: 15, lineHeight: 1, flex: '0 0 auto',
            },
          },
          icon,
        ),
      );
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return;
      if (!ctx || typeof ctx.effect !== 'function') return;

      // [A] Pattern from the installed dsh-client-ui-quote plugin:
      // ctx.locale.register(NS, { zh, en }) returns a disposer.
      ctx.effect(function () {
        var dispose = function () {};
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            var result = ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
            if (typeof result === 'function') dispose = result;
          }
        } catch (e) { /* host teardown / locale service absent */ }
        return function () {
          try { dispose(); } catch (e) { /* host teardown */ }
        };
      }, 'prompt-enhance: dictionaries');

      // [A] ctx.slots.inject returns an idempotent disposer already bound to
      // the caller's fiber; wrapping it in ctx.effect is belt-and-braces so a
      // disable/HMR removes both the wait and the active contribution.
      ctx.effect(function () {
        var dispose = function () {};
        try {
          dispose = ctx.slots.inject('conversation.input.right', function () {
            return ctx.slots.register(
              {
                name: 'conversation.input.right',
                id: 'prompt-enhance',
                order: 5,
                locale: NS,
                inject: function () { return {}; },
              },
              EnhanceButton,
            );
          });
        } catch (e) {
          console.warn('[prompt-enhance] slot registration failed:', e);
          return function () {};
        }
        return function () {
          try { if (typeof dispose === 'function') dispose(); } catch (e) { /* host teardown */ }
        };
      }, 'prompt-enhance: composer button');
    }

    var inject = ['slots', 'locale']; // cordis service dependencies

    module.exports = {
      name: 'dsh-prompt-enhance-local',
      inject: inject,
      apply: apply,
    };
    return module.exports;
  },
});
