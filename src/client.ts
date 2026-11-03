import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { Agent, fetch, FormData, type Dispatcher } from 'undici'

export interface EmassConfig {
  /** The eMASS API host, e.g. https://emass.example.mil. */
  baseUrl: string
  apiKey: string
  /** The user's unique identifier (for DoD users, the EDIPI on their CAC). eMASS requires it for every write. */
  userUid?: string | undefined
  /** PEM client certificate and key for mutual TLS; eMASS rejects connections without one. */
  cert?: string | undefined
  key?: string | undefined
  passphrase?: string | undefined
  /** PEM CA bundle, when the eMASS host chains to a CA Node doesn't already trust (the DoD roots). */
  ca?: string | undefined
  timeoutMs?: number | undefined
  /**
   * Each call says who is making it, in its MCP `_meta` (USER_UID_META), instead of one user-uid for everyone. A host
   * that knows the signed-in person (Papyrus, from their sign-in) sets this so eMASS records each change against them.
   */
  userUidPerCall?: boolean | undefined
}

/** The `_meta` key a host puts the caller's user-uid under when `userUidPerCall` is on. */
export const USER_UID_META = 'com.beaglabs.emass/user-uid'

export class EmassError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) { super(message) }
}

export interface EmassRequest {
  method: string
  path: string
  query?: Record<string, unknown>
  json?: unknown
  /** Multipart fields; a file field holds the path of a local file. */
  form?: { fields: Record<string, unknown>; files: Record<string, string> }
  binary?: boolean
  /** The caller's own user-uid, from the call's `_meta`; used instead of the configured one. */
  userUid?: string | undefined
}
export type EmassResponse = { status: number; json: unknown } | { status: number; file: Buffer; filename?: string; contentType?: string }

/** A small eMASS REST client: mutual TLS, the api-key and user-uid headers, JSON in and out. */
export class EmassClient {
  private readonly dispatcher: Dispatcher
  constructor(private readonly config: EmassConfig) {
    this.dispatcher = new Agent({
      connect: { ...(config.cert ? { cert: config.cert } : {}), ...(config.key ? { key: config.key } : {}), ...(config.passphrase ? { passphrase: config.passphrase } : {}), ...(config.ca ? { ca: config.ca } : {}) },
      headersTimeout: config.timeoutMs ?? 120_000, bodyTimeout: config.timeoutMs ?? 120_000,
    })
  }

  get canWrite(): boolean { return Boolean(this.config.userUid || this.config.userUidPerCall) }

  url(path: string, query: Record<string, unknown> = {}): URL {
    const url = new URL(path.replace(/^\//, ''), this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`)
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value))
    }
    return url
  }

  async request(input: EmassRequest): Promise<EmassResponse> {
    const headers: Record<string, string> = { accept: input.binary ? '*/*' : 'application/json', 'api-key': this.config.apiKey }
    // The specification secures every call with both headers; eMASS itself insists on user-uid for writes.
    const userUid = input.userUid || (this.config.userUidPerCall ? undefined : this.config.userUid)
    if (userUid) headers['user-uid'] = userUid
    else if (input.method !== 'GET') throw new EmassError(0, this.config.userUidPerCall ? 'eMASS requires your user-uid for this request, and the host did not send it' : 'eMASS requires a user-uid for this request; set EMASS_USER_UID')
    let body: string | FormData | undefined
    if (input.form) {
      const form = new FormData()
      for (const [name, value] of Object.entries(input.form.fields)) if (value !== undefined && value !== null) form.set(name, typeof value === 'string' ? value : String(value))
      for (const [name, path] of Object.entries(input.form.files)) form.set(name, new Blob([await readFile(path)]), basename(path))
      body = form
    } else if (input.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(input.json)
    }
    const response = await fetch(this.url(input.path, input.query), { method: input.method, headers, ...(body !== undefined ? { body } : {}), dispatcher: this.dispatcher })
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok) {
      const raw = await response.text()
      let parsed: unknown = raw
      try { parsed = JSON.parse(raw) } catch { /* not JSON */ }
      const meta = (parsed as { meta?: { errorMessage?: string } } | undefined)?.meta
      throw new EmassError(response.status, `eMASS returned ${response.status}${meta?.errorMessage ? `: ${meta.errorMessage}` : raw && typeof parsed === 'string' ? `: ${raw.slice(0, 500)}` : ''}`, parsed)
    }
    if (input.binary && !contentType.includes('application/json')) {
      const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
      return { status: response.status, file: Buffer.from(await response.arrayBuffer()), ...(filename ? { filename: decodeURIComponent(filename) } : {}), ...(contentType ? { contentType } : {}) }
    }
    const raw = await response.text()
    if (!raw) return { status: response.status, json: null }
    try { return { status: response.status, json: JSON.parse(raw) } } catch { return { status: response.status, json: raw } }
  }

  close(): Promise<void> { return this.dispatcher.close() }
}
