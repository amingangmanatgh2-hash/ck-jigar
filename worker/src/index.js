/**
 * The Worker's entry: a lazy door to the panel.
 *
 * `app.js` is imported on the first request instead of at startup, so anything that goes wrong while loading it is
 * a message in the response (with the stack, for `?debug=1`) instead of a bare Cloudflare "error 1101" page.
 */

export default {
  async fetch(request, env) {
    try {
      const app = await import('./app.js');
      return await app.route(request, env);
    } catch (err) {
      const debug = new URL(request.url).searchParams.has('debug');
      const detail = debug ? String(err?.stack ?? err) : String(err?.message ?? err);
      return new Response(`zeus: ${detail.slice(0, 1500)}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  },
};
