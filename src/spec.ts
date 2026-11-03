import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/** MITRE's eMASS REST OpenAPI specification (https://github.com/mitre/emass_client), bundled with this package. */
export const SPEC_PATH = fileURLToPath(new URL('../spec/eMASSRestOpenApi.yaml', import.meta.url))

type Json = Record<string, unknown>
export type JsonSchema = Json
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface Parameter { name: string; in: 'path' | 'query'; required: boolean; description: string; schema: JsonSchema }
export interface Operation {
  operationId: string
  method: Method
  path: string
  tag: string
  summary: string
  description: string
  parameters: Parameter[]
  /** The request body, if any: JSON is sent as is; multipart fields marked `binary` are read from local files. */
  body?: { contentType: 'application/json' | 'multipart/form-data'; required: boolean; schema: JsonSchema; files: string[] }
  /** The response is a file (artifact export), not JSON. */
  binaryResponse: boolean
}

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'DELETE']
// Keywords that only document the API or that MCP clients don't need; dropping them keeps tool schemas small.
const DROP = new Set(['example', 'examples', 'xml', 'externalDocs', 'readOnly', 'writeOnly', 'discriminator'])

/** Inlines every local `$ref`, drops documentation-only keywords, and makes OpenAPI 3.0 `nullable` JSON Schema. */
function resolver(root: Json) {
  const lookup = (ref: string): unknown => ref.replace(/^#\//, '').split('/').reduce<unknown>((node, key) => (node as Json | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root)
  const resolve = (node: unknown, seen: string[] = []): unknown => {
    if (Array.isArray(node)) return node.map(item => resolve(item, seen))
    if (!node || typeof node !== 'object') return node
    const object = node as Json
    if (typeof object.$ref === 'string') {
      const ref = object.$ref
      // A schema that contains itself is left open rather than expanded forever.
      if (seen.includes(ref)) return {}
      return resolve(lookup(ref), [...seen, ref])
    }
    const out: Json = {}
    for (const [key, value] of Object.entries(object)) {
      if (DROP.has(key) || key.startsWith('x-')) continue
      if (key === 'nullable') continue
      out[key] = key === 'properties' && value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value as Json).map(([name, schema]) => [name, resolve(schema, seen)]))
        : resolve(value, seen)
    }
    if (object.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null']
    return out
  }
  return resolve
}

const text = (value: unknown) => typeof value === 'string' ? value.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : ''

/** Every operation in the specification, with parameters and bodies resolved. */
export function loadOperations(path = SPEC_PATH): Operation[] {
  const root = parse(readFileSync(path, 'utf8')) as Json
  const resolve = resolver(root)
  const operations: Operation[] = []
  for (const [route, item] of Object.entries(root.paths as Json)) {
    const pathItem = item as Json
    const shared = (pathItem.parameters as unknown[] | undefined) ?? []
    for (const method of METHODS) {
      const raw = pathItem[method.toLowerCase()] as Json | undefined
      if (!raw) continue
      const parameters = ([...shared, ...((raw.parameters as unknown[] | undefined) ?? [])].map(value => resolve(value)) as Json[])
        .filter(parameter => parameter.in === 'path' || parameter.in === 'query')
        .map(parameter => ({ name: String(parameter.name), in: parameter.in as 'path' | 'query', required: parameter.in === 'path' || parameter.required === true, description: text(parameter.description), schema: (parameter.schema as JsonSchema | undefined) ?? { type: 'string' } }))
      const requestBody = resolve(raw.requestBody) as Json | undefined
      const content = requestBody?.content as Record<string, { schema?: JsonSchema }> | undefined
      let body: Operation['body']
      if (content?.['application/json']) body = { contentType: 'application/json', required: requestBody?.required === true, schema: content['application/json'].schema ?? {}, files: [] }
      else if (content?.['multipart/form-data']) {
        const schema = content['multipart/form-data'].schema ?? {}
        const files = Object.entries((schema.properties as Record<string, JsonSchema> | undefined) ?? {}).filter(([, property]) => property.format === 'binary').map(([name]) => name)
        body = { contentType: 'multipart/form-data', required: requestBody?.required === true, schema, files }
      }
      const ok = ((resolve(raw.responses) as Json | undefined)?.['200'] as Json | undefined)?.content as Json | undefined
      operations.push({
        operationId: String(raw.operationId), method, path: route, tag: String((raw.tags as string[] | undefined)?.[0] ?? ''),
        summary: text(raw.summary), description: text(raw.description), parameters,
        ...(body ? { body } : {}),
        binaryResponse: Boolean(ok && !ok['application/json'] && ok['application/octet-stream']),
      })
    }
  }
  return operations
}
