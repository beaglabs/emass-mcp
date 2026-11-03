import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server'
import { EmassError, USER_UID_META, type EmassClient } from './client.js'
import type { JsonSchema, Operation } from './spec.js'

const DASHBOARD_PREFIX = '/api/dashboards/'
const MAX_TEXT = 200_000
const MAX_DESCRIPTION = 2_000

const snake = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase()
export const toolName = (operation: Operation) => `emass_${snake(operation.operationId)}`
const clip = (value: string, max = MAX_DESCRIPTION) => value.length > max ? `${value.slice(0, max)}…` : value

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  write: boolean
  operation?: Operation
  /** For the combined dashboard tool: each dashboard's operation by its slug. */
  dashboards?: Map<string, Operation>
}

/** The tool's arguments, from the operation's path and query parameters and its body. */
function inputSchema(operation: Operation): JsonSchema {
  const properties: Record<string, JsonSchema> = {}, required: string[] = []
  for (const parameter of operation.parameters) {
    properties[parameter.name] = { ...parameter.schema, ...(parameter.description ? { description: clip(parameter.description, 600) } : {}) }
    if (parameter.required) required.push(parameter.name)
  }
  const body = operation.body
  if (body?.contentType === 'application/json') {
    properties.body = { ...body.schema, description: clip(`Request body sent to eMASS as JSON.${body.schema.description ? ` ${String(body.schema.description)}` : ''}`, 600) }
    if (body.required) required.push('body')
  } else if (body?.contentType === 'multipart/form-data') {
    const fields = (body.schema.properties as Record<string, JsonSchema> | undefined) ?? {}
    for (const [name, field] of Object.entries(fields)) {
      const { format: _format, ...rest } = field
      properties[name] = body.files.includes(name) ? { type: 'string', description: `Path of a local file to upload. ${String(field.description ?? '')}`.trim() } : rest
    }
    for (const name of (body.schema.required as string[] | undefined) ?? []) if (!required.includes(name)) required.push(name)
  }
  if (operation.binaryResponse) properties.saveTo = { type: 'string', description: 'Where to save the downloaded file. Defaults to EMASS_DOWNLOAD_DIR (or the temp directory) under the name eMASS gives it.' }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

/** One tool per operation, except the dashboards, which share one tool chosen by `dashboard`. */
export function buildTools(operations: Operation[]): Tool[] {
  const tools: Tool[] = []
  const dashboards = new Map<string, Operation>()
  for (const operation of operations) {
    if (operation.method === 'GET' && operation.path.startsWith(DASHBOARD_PREFIX)) { dashboards.set(operation.path.slice(DASHBOARD_PREFIX.length), operation); continue }
    tools.push({
      name: toolName(operation),
      title: operation.summary || operation.operationId,
      description: clip([operation.summary, operation.description, `${operation.method} ${operation.path}`].filter(Boolean).join('\n\n')),
      inputSchema: inputSchema(operation),
      write: operation.method !== 'GET',
      operation,
    })
  }
  if (dashboards.size) {
    const properties: Record<string, JsonSchema> = {}
    for (const operation of dashboards.values()) for (const parameter of operation.parameters) properties[parameter.name] ??= { ...parameter.schema, ...(parameter.description ? { description: clip(parameter.description, 400) } : {}) }
    const list = [...dashboards].map(([slug, operation]) => `- ${slug}: ${operation.summary}`).join('\n')
    tools.push({
      name: 'emass_get_dashboard',
      title: 'Get an eMASS dashboard',
      description: `Reads one of eMASS's ${dashboards.size} dashboards for an organization. Dashboards are paged (pageIndex, pageSize). Available dashboards:\n${list}`,
      inputSchema: { type: 'object', properties: { dashboard: { type: 'string', enum: [...dashboards.keys()], description: 'Which dashboard to read.' }, ...properties }, required: ['dashboard', 'orgId'], additionalProperties: false },
      write: false,
      dashboards,
    })
  }
  return tools
}

/** Splits a tool's arguments back into the eMASS request: path, query, body, files. */
export function toRequest(operation: Operation, args: Record<string, unknown>) {
  let path = operation.path
  const query: Record<string, unknown> = {}
  for (const parameter of operation.parameters) {
    const value = args[parameter.name]
    if (parameter.in === 'path') {
      if (value === undefined || value === null || value === '') throw new Error(`${parameter.name} is required`)
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)))
    } else if (value !== undefined) query[parameter.name] = value
  }
  const body = operation.body
  if (body?.contentType === 'multipart/form-data') {
    const names = Object.keys((body.schema.properties as Record<string, unknown> | undefined) ?? {})
    const fields: Record<string, unknown> = {}, files: Record<string, string> = {}
    for (const name of names) {
      const value = args[name]
      if (value === undefined) continue
      if (body.files.includes(name)) files[name] = resolve(String(value))
      else fields[name] = value
    }
    return { method: operation.method, path, query, form: { fields, files }, binary: operation.binaryResponse }
  }
  return { method: operation.method, path, query, ...(args.body !== undefined ? { json: args.body } : {}), binary: operation.binaryResponse }
}

const textResult = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated ${text.length - MAX_TEXT} characters; narrow the request or page through it]` : text }], ...(isError ? { isError: true } : {}) })

export async function callTool(tool: Tool, client: EmassClient, args: Record<string, unknown>, downloadDir?: string, userUid?: string) {
  let operation = tool.operation
  if (tool.dashboards) {
    const { dashboard, ...rest } = args
    operation = tool.dashboards.get(String(dashboard))
    if (!operation) return textResult(`Unknown dashboard ${String(dashboard)}`, true)
    args = rest
  }
  if (!operation) return textResult('This tool has no eMASS operation', true)
  try {
    const response = await client.request({ ...toRequest(operation, args), ...(userUid ? { userUid } : {}) })
    if ('file' in response) {
      const target = typeof args.saveTo === 'string' && args.saveTo ? resolve(args.saveTo) : join(downloadDir ?? join(tmpdir(), 'emass-mcp'), response.filename ?? String(args.filename ?? 'artifact'))
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, response.file)
      return textResult(JSON.stringify({ savedTo: target, bytes: response.file.length, ...(response.contentType ? { contentType: response.contentType } : {}) }, null, 2))
    }
    return textResult(JSON.stringify(response.json, null, 2))
  } catch (cause) {
    if (cause instanceof EmassError) return textResult(`${cause.message}${cause.body !== undefined && typeof cause.body !== 'string' ? `\n${JSON.stringify(cause.body, null, 2)}` : ''}`, true)
    return textResult(cause instanceof Error ? cause.message : String(cause), true)
  }
}

/**
 * Registers the eMASS tools. Writes need a user-uid (eMASS refuses them without one), so without it only reads are
 * offered.
 */
export function registerTools(server: McpServer, tools: Tool[], client: EmassClient, downloadDir?: string): Tool[] {
  const offered = tools.filter(tool => !tool.write || client.canWrite)
  for (const tool of offered) {
    const method = tool.operation?.method ?? 'GET'
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as never),
      annotations: { title: tool.title, readOnlyHint: method === 'GET', destructiveHint: method === 'DELETE' || method === 'PUT', idempotentHint: method !== 'POST', openWorldHint: true },
    }, async (args, ctx) => {
      const uid = (ctx as { mcpReq?: { _meta?: Record<string, unknown> } } | undefined)?.mcpReq?._meta?.[USER_UID_META]
      return callTool(tool, client, (args ?? {}) as Record<string, unknown>, downloadDir, typeof uid === 'string' && uid ? uid : undefined)
    })
  }
  return offered
}
