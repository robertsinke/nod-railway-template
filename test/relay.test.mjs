// Contract tests for the docker-exec replacement: the `docker` shim (server side)
// talking to nod-relay-agent (workspace and browser side) over TCP.
// Run: node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = join(root, 'relay', 'nod-relay-agent.mjs');
const shimPath = join(root, 'relay', 'docker');
const token = 'a'.repeat(64);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nod-relay-')));
const workspaceRoot = join(scratch, 'workspace');
mkdirSync(workspaceRoot);
const agents = [];

function startAgent(mode, port, extraEnv = {}) {
  const child = spawn(process.execPath, [agentPath], {
    env: {
      PATH: process.env.PATH,
      NOD_RELAY_MODE: mode,
      NOD_RELAY_TOKEN: token,
      NOD_RELAY_PORT: String(port),
      NOD_RELAY_TEST: '1',
      NOD_RELAY_WORKSPACE_ROOT: workspaceRoot,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agents.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => d.toString().includes('listening') && resolve(child));
    child.on('exit', (code) => reject(new Error(`agent exited ${code}`)));
  });
}

const config = join(scratch, 'docker-config');
before(async () => {
  mkdirSync(config);
  writeFileSync(
    join(config, 'nod-relay.json'),
    JSON.stringify({
      token,
      workspace: '127.0.0.1:47101',
      browser: '127.0.0.1:47102',
      connectTimeoutMs: 3000,
    }),
  );
  await startAgent('workspace', 47101);
  await startAgent('browser', 47102, { NOD_RELAY_BROWSER_BRIDGE: join(scratch, 'bridge.mjs') });
  writeFileSync(
    join(scratch, 'bridge.mjs'),
    "process.stdin.on('data', d => process.stdout.write('bridge:' + d));",
  );
});
after(() => agents.forEach((a) => a.kill('SIGKILL')));

function docker(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(shimPath, args, {
      env: { PATH: process.env.PATH, DOCKER_CONFIG: config, ...env },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }),
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const thread = '0b5c3a3e-6f6d-4f0e-9a51-1d2c3b4a5f60';
const wsArgs = (cmd) => [
  'exec', '-i', '--user', 'node', '--workdir', `/workspace/${thread}`, 'nod-workspace', ...cmd,
];

test('workspace exec pipes stdin to stdout byte for byte', async () => {
  const payload = Buffer.from([0, 1, 2, 255, 10, 65]);
  const r = await docker(wsArgs(['/bin/cat']), { input: payload });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout, payload);
});

test('workspace exec propagates the exit code and separates stderr', async () => {
  const r = await docker(wsArgs(['/bin/sh', '-c', 'echo out; echo err >&2; exit 7']));
  assert.equal(r.code, 7);
  assert.equal(r.stdout.toString(), 'out\n');
  assert.match(r.stderr, /err/);
});

test('workspace exec creates and enters the thread workdir', async () => {
  const r = await docker(wsArgs(['/bin/pwd']));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.toString().trim(), join(workspaceRoot, thread));
  assert.ok(existsSync(join(workspaceRoot, thread)));
});

test('the relay token never reaches the executed command', async () => {
  const r = await docker(wsArgs(['/usr/bin/env']));
  assert.equal(r.code, 0, r.stderr);
  const env = r.stdout.toString();
  assert.doesNotMatch(env, /NOD_RELAY/);
  assert.doesNotMatch(env, new RegExp(token));
  assert.match(env, /^HOME=/m);
});

test('the shim exits when the command exits even if its stdin stays open', async () => {
  // The browser bridge client never closes stdin (src/providers/container-browser/client.ts).
  const result = await new Promise((resolve) => {
    const child = spawn(shimPath, wsArgs(['/bin/sh', '-c', 'echo done; exit 3']), {
      env: { PATH: process.env.PATH, DOCKER_CONFIG: config },
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString() });
    });
  });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'done\n');
});

test('node may run in /var/tmp', async () => {
  const r = await docker([
    'exec', '-i', '--user', 'node', '--workdir', '/var/tmp', 'nod-workspace', '/bin/pwd',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.toString().trim(), realpathSync('/var/tmp'));
});

test('a workdir outside the workspace is refused', async () => {
  const r = await docker([
    'exec', '-i', '--user', 'node', '--workdir', '/etc', 'nod-workspace', '/bin/pwd',
  ]);
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout.length, 0);
});

test('a wrong token is refused', async () => {
  const bad = join(scratch, 'bad-config');
  mkdirSync(bad);
  writeFileSync(
    join(bad, 'nod-relay.json'),
    JSON.stringify({ token: 'b'.repeat(64), workspace: '127.0.0.1:47101', browser: '127.0.0.1:47102' }),
  );
  const r = await docker(wsArgs(['/bin/echo', 'hi']), { env: { DOCKER_CONFIG: bad } });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout.length, 0);
});

test('browser exec only runs the bridge', async () => {
  const ok = await docker(['exec', '-i', '--user', 'node', 'nod-browser', 'node', '/app/bridge.mjs'], {
    input: 'ping',
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout.toString(), 'bridge:ping');
  const bad = await docker(['exec', '-i', '--user', 'node', 'nod-browser', '/bin/sh', '-c', 'id']);
  assert.notEqual(bad.code, 0);
  assert.equal(bad.stdout.length, 0);
});

test('connected-CLI users must use /var/tmp', async () => {
  const r = await docker([
    'exec', '-i', '--user', '20001:1002', '--workdir', `/workspace/${thread}`, 'nod-workspace', '/bin/pwd',
  ]);
  assert.notEqual(r.code, 0);
});

test('an unreachable relay fails fast with a nonzero exit', async () => {
  const dead = join(scratch, 'dead-config');
  mkdirSync(dead);
  writeFileSync(
    join(dead, 'nod-relay.json'),
    JSON.stringify({ token, workspace: '127.0.0.1:47199', browser: '127.0.0.1:47199', connectTimeoutMs: 500 }),
  );
  const r = await docker(wsArgs(['/bin/echo', 'hi']), { env: { DOCKER_CONFIG: dead } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /relay/i);
});
