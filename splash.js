/**
 * dsh-mikufan — Host half of the "Startup animation" component.
 *
 * The Web UI's startup animation is the five-second "光点汇聚" splash the user
 * authored in `dsh-splash/index.html` (copied verbatim into `splash/index.html`).
 * A page-load splash cannot be mounted by the Client half: the whole point is to
 * cover the interval before the React shell exists. So the Host:
 *
 * 1. contributes three `webserver/index-inject` rows — a style, the cover
 *    markup and the bootstrap script — which the Web server renders into
 *    `index.html` immediately after `<body>`, before the app module runs;
 * 2. serves the self-contained animation at `GET /mikufan/splash`, composing
 *    it with `splash/embed-bridge.html` (the asset file itself stays pristine);
 * 3. exposes the on/off preference through the existing `mikufan/api` route
 *    family so the General-settings row can flip it.
 *
 * The cover fails open: a document that never receives the splash's `ready`
 * message is uncovered after a few seconds, and every failure path removes the
 * cover rather than trapping the app behind a black rectangle.
 *
 * @module dsh-mikufan/splash
 */
import { readFile, stat } from 'node:fs/promises';

/** Exact route serving the splash document (also the cover's iframe source). */
export const SPLASH_ROUTE = '/mikufan/splash';
/** Relative iframe source: resolves under a public-URL base path like the app's own assets. */
const SPLASH_IFRAME_SRC = 'mikufan/splash';
/** The standalone animation, copied byte-for-byte from the user's asset. */
const SPLASH_HTML_URL = new URL('./splash/index.html', import.meta.url);
/** The embed-only bridge inserted at serve time. */
const SPLASH_BRIDGE_URL = new URL('./splash/embed-bridge.html', import.meta.url);
/** How long a splash that never reports readiness may hold the cover. */
const READY_TIMEOUT_MS = 7000;
/** How long the frozen end frame is held before the cover dissolves. */
const END_HOLD_MS = 650;

/**
 * Cover stylesheet: a fixed, opaque stage above every app layer. The stage is
 * deliberately its own dark artwork (like the splash) rather than a theme
 * surface: a boot animation is a brand frame, and the app underneath may still
 * be mounting in either theme.
 */
const SPLASH_STYLE = `
#dsh-mikufan-boot{position:fixed;inset:0;z-index:2147483000;background:#050507;overflow:hidden;opacity:1;isolation:isolate;user-select:none;-webkit-user-select:none;transition:opacity .5s cubic-bezier(.4,0,.2,1)}
#dsh-mikufan-boot[data-mikufan-leaving="1"]{opacity:0;pointer-events:none}
#dsh-mikufan-boot-frame{position:absolute;inset:0;display:block;width:100%;height:100%;border:0;background:#050507}
#dsh-mikufan-boot-shield{position:absolute;inset:0;cursor:default}
@media (prefers-reduced-motion:reduce){#dsh-mikufan-boot{transition:none}}
`;

/**
 * Cover markup, rendered at the top of `<body>`. The transparent shield sits
 * above the iframe so a click anywhere (not only on the page background) is a
 * skip; the iframe keeps `tabindex="-1"` and is decorative here.
 */
const SPLASH_MARKUP = `<div id="dsh-mikufan-boot" data-mikufan-boot="" aria-hidden="true"><iframe id="dsh-mikufan-boot-frame" src="${SPLASH_IFRAME_SRC}" title="DeepSeek Harness startup animation" tabindex="-1" scrolling="no"></iframe><div id="dsh-mikufan-boot-shield"></div></div>`;

/**
 * Cover bootstrap, rendered right after the markup and executed while the
 * document is parsed: skip (any key / click), dissolve on the splash's `ended`
 * signal, and fail open when the iframe never becomes ready. It is a plain
 * classic script: it must not wait for a module graph that may be slow to load.
 */
const SPLASH_BOOT_SCRIPT = `
(() => {
  const overlay = document.getElementById('dsh-mikufan-boot');
  if (overlay === null || overlay.dataset.mikufanBound === '1') return;
  overlay.dataset.mikufanBound = '1';
  /* The one-click restart reloads the page the moment the process is back; that
     load already played this animation over the downtime, so it enters
     directly. One-shot: the flag is consumed here. */
  try {
    if (sessionStorage.getItem('dsh-mikufan:boot-splash-skip') === '1') {
      sessionStorage.removeItem('dsh-mikufan:boot-splash-skip');
      if (overlay.parentNode !== null) overlay.parentNode.removeChild(overlay);
      return;
    }
  } catch (error) {
    /* no sessionStorage: play the animation like any other load */
  }
  const frame = document.getElementById('dsh-mikufan-boot-frame');
  const shield = document.getElementById('dsh-mikufan-boot-shield');
  const params = new URLSearchParams(window.location.search);
  const reduced = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let failTimer = 0;
  let ready = false;
  let leaving = false;

  const remove = () => {
    if (overlay.parentNode !== null) overlay.parentNode.removeChild(overlay);
  };
  const onMessage = (event) => {
    if (frame === null || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== 'dsh-mikufan-splash') return;
    if (data.type === 'ready') {
      ready = true;
      if (failTimer !== 0) {
        window.clearTimeout(failTimer);
        failTimer = 0;
      }
      overlay.setAttribute('data-mikufan-ready', '1');
      return;
    }
    if (data.type === 'ended') {
      /* Hold the frozen end frame briefly, then dissolve into the app. */
      window.setTimeout(() => finish(false), ${END_HOLD_MS});
    }
  };
  const finish = (immediate) => {
    if (leaving) return;
    leaving = true;
    if (failTimer !== 0) {
      window.clearTimeout(failTimer);
      failTimer = 0;
    }
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('message', onMessage);
    if (immediate || reduced) {
      remove();
      return;
    }
    overlay.setAttribute('data-mikufan-leaving', '1');
    window.setTimeout(remove, 520);
  };
  const onKeyDown = (event) => {
    /* Any key skips the animation. Modifier combos pass through (copy/paste,
       browser shortcuts), and a modifier key alone is not a skip gesture. */
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt'
      || event.key === 'Shift' || event.key === 'CapsLock') return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  };

  /* Escape hatches: explicit opt-out for one load, and a background tab that
     was opened by a script should not play a five-second animation unseen. */
  if (params.get('mikufan-splash') === 'off' || document.visibilityState === 'hidden') {
    finish(true);
    return;
  }

  window.addEventListener('keydown', onKeyDown, true);
  if (shield !== null) {
    shield.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      finish(false);
    }, { passive: false });
  }
  window.addEventListener('message', onMessage);

  /* Fail open: a missing/broken splash must never trap the UI. */
  failTimer = window.setTimeout(() => {
    if (!ready) finish(false);
  }, ${READY_TIMEOUT_MS});
})();
`;

/**
 * Index-injection rows for one `webserver/index-inject` render.
 *
 * @param enabled - whether the startup animation is enabled for this load.
 * @returns the rows to append, in execution order; none when disabled.
 */
export function splashIndexInjections(enabled = true) {
  if (enabled !== true) return [];
  return [
    { kind: 'style', text: SPLASH_STYLE },
    { kind: 'html', placement: 'body', html: SPLASH_MARKUP },
    { kind: 'script', placement: 'body', text: SPLASH_BOOT_SCRIPT },
  ];
}

/** Last composed splash document, keyed by both files' size and mtime. */
let cachedSplash = null;

/**
 * Read and compose the splash document: the pristine asset plus the embed
 * bridge before `</body>`. Both files are cached until either changes on disk,
 * so a bundle update (or a linked-workspace edit) is picked up without a
 * restart.
 *
 * @returns the composed HTML body and its ETag.
 */
export async function readSplashAsset() {
  const [htmlInfo, bridgeInfo] = await Promise.all([stat(SPLASH_HTML_URL), stat(SPLASH_BRIDGE_URL)]);
  const key = `${htmlInfo.size}:${htmlInfo.mtimeMs}:${bridgeInfo.size}:${bridgeInfo.mtimeMs}`;
  if (cachedSplash !== null && cachedSplash.key === key) return cachedSplash;

  const [html, bridge] = await Promise.all([
    readFile(SPLASH_HTML_URL, 'utf8'),
    readFile(SPLASH_BRIDGE_URL, 'utf8'),
  ]);
  const closingBody = '</body>';
  const at = html.lastIndexOf(closingBody);
  const body = at === -1 ? `${html}\n${bridge}\n` : `${html.slice(0, at)}${bridge}\n${html.slice(at)}`;
  cachedSplash = {
    key,
    body,
    etag: `"${htmlInfo.size.toString(16)}-${Math.round(htmlInfo.mtimeMs).toString(16)}-${bridgeInfo.size.toString(16)}"`,
  };
  return cachedSplash;
}

/** The browser trust fence shared with the API routes, or no rejection. */
function requestRejection(ctx, req) {
  try {
    const connection = ctx.get?.('connection');
    if (connection === undefined) return undefined;
    return connection.requestRejection(req);
  } catch {
    return undefined;
  }
}

/**
 * Build the `GET /mikufan/splash` handler.
 *
 * @param options - host context and reporter.
 * @returns the route handler.
 */
export function createSplashRouteHandler({ ctx, log }) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const rejection = requestRejection(ctx, req);
    if (rejection !== undefined) {
      res.writeHead(rejection);
      res.end();
      return;
    }
    let asset;
    try {
      asset = await readSplashAsset();
    } catch (error) {
      log(`failed to read the splash asset: ${error?.message ?? error}`);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('splash asset unavailable');
      return;
    }
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      etag: asset.etag,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'no-referrer',
    };
    if (req.headers?.['if-none-match'] === asset.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  };
}

/** Test surface: the pure rows, the asset composer and the route handler. */
export const __splashInternal = {
  SPLASH_STYLE,
  SPLASH_MARKUP,
  SPLASH_BOOT_SCRIPT,
  SPLASH_ROUTE,
  READY_TIMEOUT_MS,
  END_HOLD_MS,
  readSplashAsset,
  createSplashRouteHandler,
};
