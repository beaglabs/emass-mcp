import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttp, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttps } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EmassClient } from '../src/client.js'
import { createServer } from '../src/index.js'
import { loadOperations } from '../src/spec.js'
import { buildTools } from '../src/tools.js'

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string }
const seen: Seen[] = []
const handler = (request: IncomingMessage, response: import('node:http').ServerResponse) => {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk)).on('end', () => {
    seen.push({ method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
    if (request.url?.startsWith('/api/systems/7/artifacts-export')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="ssp.pdf"' }).end('PDFDATA')
      return
    }
    if (request.url === '/api/systems/404') { response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ meta: { code: 404, errorMessage: 'System not found' } })); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ meta: { code: 200 }, data: { echo: request.url } }))
  })
}

let http: Server, base = ''
beforeAll(async () => { http = createHttp(handler); await new Promise<void>(done => http.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${(http.address() as AddressInfo).port}` })
afterAll(() => new Promise<void>(done => http.close(() => done())))

async function connect(userUid?: string, downloadDir?: string, userUidPerCall = false) {
  const emass = new EmassClient({ baseUrl: base, apiKey: 'key-123', userUid, userUidPerCall })
  const { server, tools } = createServer(emass, downloadDir)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  return { client, tools }
}
const text = (result: { content: unknown }) => (result.content as Array<{ text: string }>)[0]!.text

describe('spec', () => {
  it('covers every operation in the eMASS specification, with dashboards in one tool', () => {
    const operations = loadOperations()
    expect(operations).toHaveLength(104)
    const tools = buildTools(operations)
    const dashboard = tools.find(tool => tool.name === 'emass_get_dashboard')!
    expect(dashboard.dashboards!.size + tools.length - 1).toBe(104)
    expect(tools.map(tool => tool.name)).toContain('emass_get_system_poams')
    expect(JSON.stringify(tools.map(tool => tool.inputSchema))).not.toContain('$ref')
  })
})

describe('server', () => {
  it('offers reads only until a user-uid is set, since eMASS refuses writes without one', async () => {
    const reads = await connect()
    const names = (await reads.client.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('emass_get_systems')
    expect(names).not.toContain('emass_add_poam_by_system_id')
    const writes = await connect('1234567890')
    const all = (await writes.client.listTools()).tools
    expect(all.find(tool => tool.name === 'emass_delete_poam')?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    expect(all.find(tool => tool.name === 'emass_get_systems')?.annotations).toMatchObject({ readOnlyHint: true })
  })

  it('sends path and query parameters with the api-key header', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'emass_get_system_poams', arguments: { systemId: 7, scheduledCompletionDateStart: '1700000000' } })
    expect(result.isError).toBeFalsy()
    const request = seen.at(-1)!
    expect(request.url).toBe('/api/systems/7/poams?scheduledCompletionDateStart=1700000000')
    expect(request.headers['api-key']).toBe('key-123')
    expect(request.headers['user-uid']).toBeUndefined()
    expect(JSON.parse(text(result)).data.echo).toBe('/api/systems/7/poams?scheduledCompletionDateStart=1700000000')
  })

  it('sends the user-uid on every call once it is set, and JSON bodies as is', async () => {
    const { client } = await connect('1234567890')
    const body = [{ status: 'Ongoing', vulnerabilityDescription: 'x', sourceIdentifyingVulnerability: 'scan', pocOrganization: 'org', resources: 'none' }]
    const result = await client.callTool({ name: 'emass_add_poam_by_system_id', arguments: { systemId: 7, body } })
    expect(result.isError, text(result)).toBeFalsy()
    const request = seen.at(-1)!
    expect(request.method).toBe('POST')
    expect(request.headers['user-uid']).toBe('1234567890')
    expect(JSON.parse(request.body)).toEqual(body)
  })

  it('takes each caller\'s user-uid from the call\'s _meta when the host sends one per call, and never falls back', async () => {
    const { client } = await connect('shared-admin', undefined, true)
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('emass_add_poam_by_system_id')
    await client.callTool({ name: 'emass_add_poam_by_system_id', arguments: { systemId: 7, body: [] }, _meta: { 'com.beaglabs.emass/user-uid': '1112223334' } })
    expect(seen.at(-1)!.headers['user-uid']).toBe('1112223334')
    const missing = await client.callTool({ name: 'emass_delete_poam', arguments: { systemId: 7, body: [] } })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('the host did not send it')
  })

  it('routes the dashboard tool to the chosen dashboard', async () => {
    const { client } = await connect()
    await client.callTool({ name: 'emass_get_dashboard', arguments: { dashboard: 'system-poam-details', orgId: 1, pageSize: 50 } })
    expect(seen.at(-1)!.url).toBe('/api/dashboards/system-poam-details?orgId=1&pageSize=50')
  })

  it('uploads artifacts from a local file as multipart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emass-test-'))
    const file = join(dir, 'evidence.txt'); writeFileSync(file, 'proof')
    const { client } = await connect('1234567890')
    const result = await client.callTool({ name: 'emass_add_artifacts_by_system_id', arguments: { systemId: 7, filename: file, type: 'Other', category: 'Evidence' } })
    expect(result.isError, text(result)).toBeFalsy()
    const request = seen.at(-1)!
    expect(request.headers['content-type']).toMatch(/^multipart\/form-data/)
    expect(request.body).toContain('filename="evidence.txt"')
    expect(request.body).toContain('proof')
    expect(request.body).toContain('Evidence')
  })

  it('saves exported artifact files to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emass-dl-'))
    const { client } = await connect(undefined, dir)
    const result = await client.callTool({ name: 'emass_get_system_artifacts_export', arguments: { systemId: 7, filename: 'ssp.pdf' } })
    const saved = JSON.parse(text(result))
    expect(saved.savedTo).toBe(join(dir, 'ssp.pdf'))
    expect(readFileSync(saved.savedTo, 'utf8')).toBe('PDFDATA')
  })

  it('reports eMASS errors as tool errors with eMASS\'s message', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'emass_get_system', arguments: { systemId: 404 } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('System not found')
  })
})

describe('mutual TLS', () => {
  it('presents the client certificate eMASS requires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emass-tls-'))
    const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Test CA')
    for (const name of ['server', 'client']) {
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name === 'server' ? 'localhost' : 'emass-user'}`)
      writeFileSync(join(dir, `${name}.ext`), name === 'server' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1' : 'extendedKeyUsage=clientAuth')
      ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`)
    }
    const read = (name: string) => readFileSync(join(dir, name), 'utf8')
    let subject = ''
    const https = createHttps({ key: read('server.key'), cert: read('server.pem'), ca: read('ca.pem'), requestCert: true, rejectUnauthorized: true }, (request, response) => {
      subject = (request.socket as import('node:tls').TLSSocket).getPeerCertificate().subject.CN as string
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}')
    })
    await new Promise<void>(done => https.listen(0, '127.0.0.1', done))
    const url = `https://127.0.0.1:${(https.address() as AddressInfo).port}`
    try {
      const withCert = new EmassClient({ baseUrl: url, apiKey: 'k', cert: read('client.pem'), key: read('client.key'), ca: read('ca.pem') })
      expect(await withCert.request({ method: 'GET', path: '/api/systems' })).toEqual({ status: 200, json: { data: [] } })
      expect(subject).toBe('emass-user')
      const without = new EmassClient({ baseUrl: url, apiKey: 'k', ca: read('ca.pem') })
      await expect(without.request({ method: 'GET', path: '/api/systems' })).rejects.toThrow()
      await withCert.close(); await without.close()
    } finally { https.close() }
  })
})
