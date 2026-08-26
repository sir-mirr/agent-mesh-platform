/**
 * GitHub OAuth + JWT authentication helpers for agent-mesh HTTP API.
 */

import { Jwt } from 'hono/utils/jwt'

// --- Environment ---

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? ''
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? ''
/**
 * The signing secret, **required**.
 *
 * It used to fall back to a published constant, which is worse than no
 * authentication: every session token this process issued could be forged by
 * anyone who had read the source, and nothing anywhere said so. A deployment
 * that forgot the variable looked exactly like one that had set it.
 *
 * Failing at startup is the point. An unset secret is a misconfiguration, and
 * a misconfiguration that runs is one nobody finds.
 */
export const refuseToStart = (message: string): never => {
  console.error(message)
  process.exit(1)
}

/**
 * `refuse` is a parameter so the refusal can be observed. Calling this with no
 * secret is the whole behaviour, and the only way to run it in-process without
 * ending the process is to hand it somewhere else to go.
 */
export function requireJwtSecret(
  secret: string | undefined,
  refuse: (message: string) => never = refuseToStart,
): string {
  if (secret) return secret
  return refuse(
    '[http-server] JWT_SECRET is not set. Refusing to start: signing sessions ' +
      'with a default would mean anyone who has read this file can forge them.',
  )
}

const JWT_SECRET = requireJwtSecret(process.env.JWT_SECRET)
const CALLBACK_URL =
  process.env.CALLBACK_URL ??
  process.env.AGENT_MESH_CALLBACK_URL ??
  'http://127.0.0.1:3200/auth/github/callback'

/**
 * Whether a GitHub sign-in can complete on this deployment.
 *
 * **Read from the environment here rather than from the constants above.**
 * Those are captured once at import, which is right for building the
 * authorize URL and wrong for a question a caller asks: a test that sets the
 * variables would otherwise be answered by whatever was set when the module
 * first loaded, and the answer would be a fact about import order.
 *
 * Both halves are required. A client id with no secret gets a person as far
 * as GitHub and then fails the token exchange on the way back, which is the
 * worst of the three states to be in and the one that looks configured.
 */
export function githubSignInConfigured(): boolean {
  return (process.env.GITHUB_CLIENT_ID ?? '').length > 0 && (process.env.GITHUB_CLIENT_SECRET ?? '').length > 0
}

// --- GitHub OAuth helpers ---

export function getGithubAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: 'read:user',
  })
  return `https://github.com/login/oauth/authorize?${params.toString()}`
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: CALLBACK_URL,
    }),
  })

  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string }
  if (data.error || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? 'Failed to exchange code for token')
  }
  return data.access_token
}

export type GithubUser = {
  id: number
  login: string
  name: string | null
  avatar_url: string
}

export async function getGithubUser(token: string): Promise<GithubUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agent-mesh',
    },
  })

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as GithubUser
  return {
    id: data.id,
    login: data.login,
    name: data.name,
    avatar_url: data.avatar_url,
  }
}

// --- JWT helpers ---

export type JwtPayload = {
  github_id: number
  github_login: string
  role: string
  iat: number
  exp: number
}

export async function signJwt(payload: { github_id: number; github_login: string; role: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + 60 * 60 * 24 * 30, // 30 days
  }
  return await Jwt.sign(fullPayload, JWT_SECRET, 'HS256')
}

export async function verifyJwt(token: string): Promise<JwtPayload> {
  const payload = await Jwt.verify(token, JWT_SECRET, 'HS256')
  return payload as unknown as JwtPayload
}
