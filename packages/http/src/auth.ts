/**
 * GitHub OAuth + JWT authentication helpers for agent-mesh HTTP API.
 */

import { Jwt } from 'hono/utils/jwt'

// --- Environment ---

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? ''
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? ''
const JWT_SECRET = process.env.JWT_SECRET ?? 'lab-fallback-secret-change-me'
const CALLBACK_URL =
  process.env.CALLBACK_URL ??
  process.env.AGENT_MESH_CALLBACK_URL ??
  'http://127.0.0.1:3200/auth/github/callback'

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
