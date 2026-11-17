// Vercel serverless function — wraps TanStack Start's fetch handler
import server from '../dist/server/server.js'

export default async function handler(req, res) {
  const protocol = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'
  const url = `${protocol}://${host}${req.url}`

  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? null
      : new ReadableStream({
          start(controller) {
            req.on('data', (chunk) => controller.enqueue(chunk))
            req.on('end', () => controller.close())
            req.on('error', (err) => controller.error(err))
          },
        })

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith(':')) continue
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
    else headers.set(key, value)
  }

  const webRequest = new Request(url, { method: req.method, headers, body, duplex: 'half' })
  const webResponse = await server.fetch(webRequest)

  res.statusCode = webResponse.status
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'transfer-encoding') res.setHeader(key, value)
  })
  res.end(Buffer.from(await webResponse.arrayBuffer()))
}
