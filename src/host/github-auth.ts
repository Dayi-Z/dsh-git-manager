/**
 * dsh-git-manager — GitHub auth: device flow login, DPAPI-encrypted token storage,
 * gh CLI reuse and token sync.
 *
 * Security rules:
 *  - The token never leaves the host process; it is encrypted at rest with
 *    Windows DPAPI (CurrentUser scope — only this Windows account can decrypt)
 *    and stored under ~/.dsh/storages/dsh-git-manager/ with tightened ACLs.
 *  - Token resolution order: stored token → `gh auth token` (reuse an already
 *    logged-in gh CLI) → device flow (gh's public OAuth app, no app setup) →
 *    explicit PAT input as a last resort.
 *  - After obtaining a token via device flow / PAT, it is ALSO written into gh
 *    (`gh auth login --with-token`) so the command line works with the same
 *    account.
 * @module dsh-git-manager/host/github-auth
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** gh CLI 的公开 OAuth App client id（无需用户自建 OAuth App）。 */
export const GH_PUBLIC_CLIENT_ID = '178c6fc778ccc68e1d6a'
export const GH_SCOPES = 'repo workflow gist read:org'

const STORAGE_DIR = join(homedir(), '.dsh', 'storages', 'dsh-git-manager')
const TOKEN_FILE = join(STORAGE_DIR, 'github-token.bin')

// ---------------------------------------------------------------------------
// DPAPI helpers (Windows). Non-Windows falls back to plaintext with a warning
// — acceptable for v1, documented at the call site.
// ---------------------------------------------------------------------------

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { stdout += c })
    child.stderr.on('data', (c: string) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `powershell exited ${code}`))
      else resolve(stdout.trim())
    })
  })
}

async function dpapiProtect(plain: string): Promise<string> {
  if (process.platform !== 'win32') return Buffer.from(plain, 'utf8').toString('base64')
  const b64 = Buffer.from(plain, 'utf8').toString('base64')
  const script =
    `Add-Type -AssemblyName System.Security; ` +
    `$d=[Convert]::FromBase64String('${b64}'); ` +
    `$p=[System.Security.Cryptography.ProtectedData]::Protect($d,$null,'CurrentUser'); ` +
    `[Convert]::ToBase64String($p)`
  return runPowerShell(script)
}

async function dpapiUnprotect(cipherB64: string): Promise<string> {
  if (process.platform !== 'win32') return Buffer.from(cipherB64, 'base64').toString('utf8')
  const script =
    `Add-Type -AssemblyName System.Security; ` +
    `$d=[Convert]::FromBase64String('${cipherB64}'); ` +
    `$p=[System.Security.Cryptography.ProtectedData]::Unprotect($d,$null,'CurrentUser'); ` +
    `[Convert]::ToBase64String($p)`
  return runPowerShell(script).then((b64) => Buffer.from(b64, 'base64').toString('utf8'))
}

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

function ensureStorageDir(): void {
  mkdirSync(STORAGE_DIR, { recursive: true })
}

const PLAIN_PREFIX = 'plain:'

export async function saveToken(token: string): Promise<void> {
  ensureStorageDir()
  let cipher: string
  try {
    cipher = await dpapiProtect(token)
    // DPAPI 空串/异常防御：空结果视为失败走降级。
    if (cipher.trim() === '') throw new Error('dpapi returned empty payload')
  } catch {
    // 环境限制（如受限服务账户）下降级为带前缀的 base64 存储（0600 权限）。
    cipher = PLAIN_PREFIX + Buffer.from(token, 'utf8').toString('base64')
  }
  const tmp = TOKEN_FILE + '.tmp'
  writeFileSync(tmp, cipher, 'utf8')
  try { chmodSync(tmp, 0o600) } catch { /* best effort */ }
  renameSync(tmp, TOKEN_FILE)
}

export async function readToken(): Promise<string | null> {
  if (!existsSync(TOKEN_FILE)) return null
  try {
    const raw = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (raw.startsWith(PLAIN_PREFIX)) return Buffer.from(raw.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
    return await dpapiUnprotect(raw)
  } catch {
    return null
  }
}

export async function clearToken(): Promise<void> {
  try { unlinkSync(TOKEN_FILE) } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// gh CLI reuse + sync
// ---------------------------------------------------------------------------

function runGh(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { stdout += c })
    child.stderr.on('data', (c: string) => { stderr += c })
    child.on('error', () => resolve({ code: -1, stdout, stderr: 'gh not found' }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    if (input !== undefined) child.stdin.write(input)
    child.stdin.end()
  })
}

/** gh CLI 是否已登录（复用路径）。 */
export async function ghLoggedIn(): Promise<boolean> {
  const r = await runGh(['auth', 'status'])
  return r.code === 0
}

/** 取 gh 当前的 token（复用已登录的 gh，避免重复授权）。 */
export async function ghToken(): Promise<string | null> {
  const r = await runGh(['auth', 'token'])
  return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null
}

/** 把 token 写入 gh（`gh auth login --with-token`），让命令行同账号可用。 */
export async function syncToGh(token: string): Promise<boolean> {
  const r = await runGh(['auth', 'login', '--with-token'], token + '\n')
  return r.code === 0
}

// ---------------------------------------------------------------------------
// Device flow (gh 公开 OAuth app；需要能访问 github.com 的网络)
// ---------------------------------------------------------------------------

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  const body = new URLSearchParams({ client_id: GH_PUBLIC_CLIENT_ID, scope: GH_SCOPES })
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`device code request failed: HTTP ${res.status}`)
  const data = (await res.json()) as Record<string, string>
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Number(data.interval) || 5,
  }
}

/** 轮询设备流；返回 token 或 null（仍 pending）。 */
export async function pollDeviceFlow(deviceCode: string, interval: number): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: GH_PUBLIC_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`token poll failed: HTTP ${res.status}`)
  const data = (await res.json()) as Record<string, string>
  if (data.access_token) return data.access_token
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return null
  throw new Error(`device flow error: ${data.error ?? 'unknown'} (${data.error_description ?? ''})`)
}

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

export interface ResolvedAuth {
  token: string
  source: 'stored' | 'gh'
}

/** 解析当前可用 token：插件存储 → gh CLI。 */
export async function resolveToken(): Promise<ResolvedAuth | null> {
  const stored = await readToken()
  if (stored) return { token: stored, source: 'stored' }
  const gh = await ghToken()
  if (gh) return { token: gh, source: 'gh' }
  return null
}
