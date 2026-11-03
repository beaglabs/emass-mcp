#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { EmassClient, type EmassConfig } from './client.js'
import { loadOperations } from './spec.js'
import { buildTools, registerTools } from './tools.js'

/** A PEM value given inline, or the path of a file holding it. */
const pem = (value: string | undefined) => !value ? undefined : value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8')

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EmassConfig {
  const baseUrl = env.EMASS_URL, apiKey = env.EMASS_API_KEY
  const missing = [!baseUrl && 'EMASS_URL', !apiKey && 'EMASS_API_KEY'].filter(Boolean)
  if (missing.length) throw new Error(`Set ${missing.join(' and ')} (see README)`)
  return {
    baseUrl: baseUrl!, apiKey: apiKey!, userUid: env.EMASS_USER_UID || undefined, userUidPerCall: env.EMASS_USER_UID_PER_CALL === 'true',
    cert: pem(env.EMASS_CERT), key: pem(env.EMASS_KEY), passphrase: env.EMASS_KEY_PASSPHRASE || undefined, ca: pem(env.EMASS_CA),
    ...(env.EMASS_TIMEOUT_MS ? { timeoutMs: Number(env.EMASS_TIMEOUT_MS) } : {}),
  }
}

export function createServer(client: EmassClient, downloadDir?: string) {
  const server = new McpServer({ name: 'emass', version: '0.1.0' }, {
    instructions: 'Tools for the eMASS REST API: systems, roles, controls, test results, POA&Ms and milestones, artifacts, PAC/CAC approvals, hardware and software baselines, scan results, workflows, CMMC assessments and dashboards. Start with emass_get_systems to find a systemId. Dashboards need an orgId.',
  })
  const tools = registerTools(server, buildTools(loadOperations()), client, downloadDir)
  return { server, tools }
}

async function main() {
  const client = new EmassClient(configFromEnv())
  const { server, tools } = createServer(client, process.env.EMASS_DOWNLOAD_DIR)
  await server.connect(new StdioServerTransport())
  console.error(`emass-mcp: ${tools.length} tools${client.canWrite ? '' : ' (read only: set EMASS_USER_UID, or EMASS_USER_UID_PER_CALL for a host that sends each caller\'s, to enable writes)'}`)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('emass-mcp')) {
  main().catch(error => { console.error(`emass-mcp: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) })
}
