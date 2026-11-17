/**
 * Vercel Node.js Serverless Function – TanStack Start SSR entry
 *
 * Vercel rewrites all non-static requests here.
 * We bridge Node.js IncomingMessage/ServerResponse ↔ TanStack Start's
 * Web-standard fetch(request, env, ctx) handler.
 */

import server from '../dist/server/server.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
  try {
    // Reconstruct the full URL from Vercel's forwarded headers
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host =
      req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
    const url = new URL(req.url || '/', `${proto}://${host}`);

    // Convert Node.js headers to Web-standard Headers
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, String(value));
      }
    }

    // Read request body (for POST/PUT/PATCH requests)
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let body = null;
    if (hasBody) {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) body = buf;
    }

    // Build Web-standard Request
    const webReq = new Request(url.toString(), {
      method: req.method,
      headers,
      body,
    });

    // Call TanStack Start's handler
    const webRes = await server.fetch(webReq, {}, {});

    // Forward status + headers
    res.statusCode = webRes.status;
    for (const [key, value] of webRes.headers.entries()) {
      res.setHeader(key, value);
    }

    // Stream or buffer the response body
    if (webRes.body) {
      const { Readable } = await import('node:stream');
      const nodeStream = Readable.fromWeb(webRes.body);
      await new Promise((resolve, reject) => {
        nodeStream.on('error', reject);
        nodeStream.on('end', resolve);
        nodeStream.pipe(res, { end: true });
      });
    } else {
      res.end();
    }
  } catch (err) {
    console.error('[ssr] Unhandled error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain');
    }
    res.end('Internal Server Error');
  }
}
