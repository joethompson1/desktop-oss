import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'os';

const raw = process.argv[2];
if (!raw) {
  process.stderr.write('claude-agent-sidecar: no request JSON in argv[2]\n');
  process.exit(1);
}

let request;
try {
  request = JSON.parse(raw);
} catch (e) {
  process.stderr.write(`claude-agent-sidecar: failed to parse request: ${e.message}\n`);
  process.exit(1);
}

const { prompt, options: requestOptions = {} } = request;
if (!prompt) {
  process.stderr.write('claude-agent-sidecar: request missing "prompt"\n');
  process.exit(1);
}

const abortController = new AbortController();
process.on('SIGINT', () => abortController.abort());
process.on('SIGTERM', () => abortController.abort());

// Production builds ship the native `claude` binary as a Tauri resource,
// not inside a sibling `node_modules/`. The host (Rust) passes its
// absolute path via env, and we hand it to the SDK explicitly so the
// SDK's own module-resolution short-circuit isn't reached. In dev (where
// node_modules exist next to the script), the env var is unset and the
// SDK auto-locates the binary via `require.resolve()`.
const envExecutablePath = process.env.CLAUDE_AGENT_SDK_EXECUTABLE_PATH;

const options = {
  permissionMode: 'bypassPermissions',
  maxTurns: 50,
  cwd: os.homedir(),
  ...(envExecutablePath ? { pathToClaudeCodeExecutable: envExecutablePath } : {}),
  ...requestOptions,
  abortController,
};

const q = query({ prompt, options });

try {
  for await (const msg of q) {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
} catch (err) {
  process.stdout.write(
    JSON.stringify({ type: 'error', error: err?.message ?? String(err) }) + '\n',
  );
  process.exit(1);
}

process.exit(0);
