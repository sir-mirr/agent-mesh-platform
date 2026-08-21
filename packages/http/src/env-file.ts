/**
 * The optional env file, and what it is not allowed to do.
 *
 * Shared lab services take their environment from systemd's
 * `EnvironmentFile`. This loader is opt-in — it does nothing unless
 * `AGENT_MESH_ENV_FILE` (or `AGENT_MESH_HTTP_ENV_FILE`) names a path — and it
 * exists for the case systemd does not cover: somebody running the service by
 * hand on a laptop.
 *
 * **What is already in the environment wins.** A file that could override the
 * process's own environment would silently beat the deployment's
 * configuration, and the symptom would be a service running with settings
 * nobody can find by reading the unit. So the file fills gaps and never
 * replaces.
 *
 * **A file that cannot be read is not an error.** The whole thing is optional;
 * failing startup over an absent convenience would make the convenience a
 * requirement. It is silent rather than warned about for the same reason the
 * variable exists: on the deployments this matters to, nothing set it.
 *
 * Split out of `main.ts` because it ran at module scope, before any test could
 * reach it, and was therefore eleven lines of parsing that nothing had ever
 * checked. The parser takes a string and the loader takes its reader, so both
 * halves can be asked a question.
 */

/**
 * The pairs in an env file, in the order they appear.
 *
 * Deliberately literal about what it does *not* do: no quote stripping, no
 * escape sequences, no `export ` prefix, and no trimming of the key or the
 * value on their own. Only the whole line is trimmed, so `A = b` yields the
 * key `"A "` — which is a quirk worth knowing rather than one worth fixing
 * here, because fixing it would change what an existing file means.
 */
export function parseEnvFile(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // A blank line and a comment are both nothing. `#` anywhere else is a
    // value: `PASSWORD=hunter#2` is a password, not a comment.
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    // `> 0`, not `>= 0`: a line beginning with `=` has no key, and a line with
    // no `=` at all is not a setting.
    if (eq <= 0) continue;
    // Everything after the *first* `=`, so a value may contain one.
    pairs.push([trimmed.slice(0, eq), trimmed.slice(eq + 1)]);
  }
  return pairs;
}

/** Where the file is named, in the order the two variables are consulted. */
export const ENV_FILE_VARS = ["AGENT_MESH_ENV_FILE", "AGENT_MESH_HTTP_ENV_FILE"] as const;

/**
 * Fill gaps in `env` from the file it names, if it names one.
 *
 * `read` is passed in so this can be asked what it does without a file
 * existing — and so a reader that throws is a test rather than a broken
 * installation.
 */
export function loadEnvFile(
  env: Record<string, string | undefined>,
  read: (path: string) => string,
): void {
  try {
    const envPath = env[ENV_FILE_VARS[0]] ?? env[ENV_FILE_VARS[1]];
    if (!envPath) return;
    for (const [key, value] of parseEnvFile(read(envPath))) {
      if (!env[key]) env[key] = value;
    }
  } catch {
    // Optional means optional.
  }
}
