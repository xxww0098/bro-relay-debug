import http from 'node:http'
import { WebSocketServer } from 'ws'

export async function createMockHub() {
  const routes = new Map()
  const wss = new WebSocketServer({ noServer: true })
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/status/')) {
      const routeId = decodeURIComponent(req.url.slice('/v1/status/'.length).split('?')[0])
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const route = routes.get(routeId)
      if (!route || route.socket.readyState !== 1 || auth !== route.secret) {
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: 'remote_device_offline', message: 'offline', status: 409 })); return
      }
      const now = new Date().toISOString()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, routeId, connected: true, connectedAt: now, lastSeen: now, hello: route.hello ?? null }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/rpc') {
      res.writeHead(404).end(); return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body
    try { body = JSON.parse(raw) } catch { res.writeHead(400).end('{}'); return }
    const route = routes.get(String(body.routeId || ''))
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!route || !route.socket || route.socket.readyState !== 1 || auth !== route.secret) {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: 'remote_device_offline', message: 'offline', status: 409 })); return
    }
    const id = `mock-${Date.now()}-${Math.random()}`
    const response = new Promise((resolve) => {
      const timer = setTimeout(() => { route.pending.delete(id); resolve({ status: 504, body: { ok: false, code: 'timeout' } }) }, 10000)
      route.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    })
    route.socket.send(JSON.stringify({ type: 'rpc.request', id, method: body.method, path: body.path, body: body.body }))
    const result = await response
    res.writeHead(result.status || 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body ?? {}))
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/v1/device/connect') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const routeId = url.searchParams.get('routeId') || ''
      let route
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(String(data)) } catch { return }
        if (msg.type === 'device.auth') {
          route = { socket: ws, secret: String(msg.secret), pending: new Map() }
          const previous = routes.get(routeId)
          if (previous?.socket && previous.socket !== ws) previous.socket.close()
          routes.set(routeId, route)
          ws.send(JSON.stringify({ type: 'device.authenticated' }))
        } else if (msg.type === 'device.hello') {
          const { type, ...hello } = msg
          if (route) route.hello = hello
        } else if (msg.type === 'rpc.response') route?.pending.get(msg.id)?.(msg)
      })
      ws.on('close', () => { if (routes.get(routeId) === route) routes.delete(routeId) })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    disconnect() { for (const route of routes.values()) route.socket.close(); },
    async close() { for (const route of routes.values()) route.socket.close(); await new Promise((resolve) => server.close(resolve)) },
  }
}
