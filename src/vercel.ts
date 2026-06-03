import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGoblintownChatGptExpressApp,
  defaultChatGptAllowedHosts,
  defaultChatGptPublicBaseUrl,
} from "./chatgpt-app.js";

export function createGoblintownVercelApp(
  env: Record<string, string | undefined> = process.env,
) {
  const publicBaseUrl = defaultChatGptPublicBaseUrl(env);
  const hostedRuntimeRoot = join(tmpdir(), "goblintown-hosted");
  process.env.CODEX_HOME ??= join(hostedRuntimeRoot, "codex-home");
  const allowedHosts = [
    ...(defaultChatGptAllowedHosts(env) ?? []),
    publicBaseUrl,
    env.VERCEL_PROJECT_PRODUCTION_URL,
    env.VERCEL_URL,
  ].filter((value): value is string => !!value);

  return createGoblintownChatGptExpressApp({
    cwd: hostedRuntimeRoot,
    host: "0.0.0.0",
    publicBaseUrl,
    allowedHosts,
    hostedMode: true,
  }).app;
}

export default createGoblintownVercelApp();
