// nod-relay-agent: stands in for the Docker daemon's `exec` on Railway.
//
// Upstream Nod drives its workspace and browser containers only through
// `docker exec -i` over a filtered Docker socket (deployment/self-host/docker-proxy.mjs).
// Railway has no Docker socket, so each of those services runs this agent as root on
// the private network instead. The server's `docker` shim connects here, presents a
// shared token, and gets the same stdio semantics back. The allow rules mirror
// upstream docker-proxy.mjs so the server can do no more than it could upstream.
//
// Wire format, client -> agent: one JSON header line, then raw stdin bytes, then
// half-close. Agent -> client: frames of [type u8][length u32be][payload],
// type 1 = stdout, 2 = stderr, 3 = exit (payload int32be code).
import net from 'node:net';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, chownSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.NOD_RELAY_MODE;
const token = Buffer.from(process.env.NOD_RELAY_TOKEN || '');
const port = Number(process.env.NOD_RELAY_PORT || 7070);
const testing = process.env.NOD_RELAY_TEST === '1';
const workspaceRoot = process.env.NOD_RELAY_WORKSPACE_ROOT || '/workspace';
const bridgePath = process.env.NOD_RELAY_BROWSER_BRIDGE || '/app/bridge.mjs';

if (!['workspace', 'browser'].includes(mode)) throw new Error('NOD_RELAY_MODE must be workspace or browser.');
if (token.length < 32) throw new Error('NOD_RELAY_TOKEN must be at least 32 characters.');
const root = process.getuid?.() === 0;
if (!root && !testing) throw new Error('nod-relay-agent must run as root to switch users.');

// Same values the upstream images set with ENV. The executed command gets only
// these, never this process's environment (which holds the relay token and
// Railway's injected variables).
const baseEnv =
  mode === 'workspace'
    ? {
        PATH: '/opt/nod-artifacts/bin:/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
        NPM_CONFIG_PREFIX: '/home/node/.local',
        PIPX_HOME: '/home/node/.local/pipx',
        PIPX_BIN_DIR: '/home/node/.local/bin',
      }
    : { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' };
if (testing) baseEnv.PATH = process.env.PATH;

const NODE_UID = 1000;
const NODE_GID = 1000;
const threadDir = /^\/workspace\/[0-9a-f-]{36}$/;

function authorize(header) {
  const presented = Buffer.from(typeof header.token === 'string' ? header.token : '');
  if (presented.length !== token.length || !timingSafeEqual(presented, token)) return 'bad token';
  const { user, workdir, cmd } = header;
  if (!Array.isArray(cmd) || !cmd.length || cmd.some((p) => typeof p !== 'string' || p.includes('\0')))
    return 'bad command';
  if (mode === 'browser') {
    if (user !== 'node' || (workdir !== undefined && workdir !== '')) return 'browser runs as node only';
    // Nod 0.10.1+ also opens a persistent multiplexed bridge (upstream docker-proxy.mjs allows both).
    const shape = JSON.stringify(cmd);
    const multiplex = shape === JSON.stringify(['node', '/app/bridge.mjs', '--multiplex']);
    if (!multiplex && shape !== JSON.stringify(['node', '/app/bridge.mjs'])) return 'browser runs the bridge only';
    return {
      file: testing ? process.execPath : 'node',
      args: multiplex ? [bridgePath, '--multiplex'] : [bridgePath],
      uid: NODE_UID,
      gid: NODE_GID,
      cwd: testing ? undefined : '/app',
      home: '/home/node',
    };
  }
  if (user === 'node') {
    if (workdir === '/var/tmp') {
      return { file: cmd[0], args: cmd.slice(1), uid: NODE_UID, gid: NODE_GID, cwd: '/var/tmp', home: '/home/node' };
    }
    if (typeof workdir !== 'string' || !threadDir.test(workdir)) return 'workdir must be a thread workspace';
    const cwd = join(workspaceRoot, workdir.slice('/workspace/'.length));
    return { file: cmd[0], args: cmd.slice(1), uid: NODE_UID, gid: NODE_GID, cwd, home: '/home/node', create: true };
  }
  const connected = /^([2-5]\d{4}):1002$/.exec(typeof user === 'string' ? user : '');
  if (!connected || workdir !== '/var/tmp') return 'connected CLIs run in /var/tmp as their own user';
  return { file: cmd[0], args: cmd.slice(1), uid: Number(connected[1]), gid: 1002, cwd: '/var/tmp', home: '/' };
}

function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
const exitFrame = (code) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(code);
  return frame(3, b);
};

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  socket.setKeepAlive(true, 15_000);
  let buffered = Buffer.alloc(0);
  let child;
  let finished = false;
  const refuse = (why) => {
    finished = true;
    socket.end(Buffer.concat([frame(2, Buffer.from(`nod-relay: ${why}\n`)), exitFrame(126)]));
  };
  const onData = (chunk) => {
    if (child) {
      if (!child.stdin.write(chunk)) {
        socket.pause();
        child.stdin.once('drain', () => socket.resume());
      }
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(10);
    if (newline < 0) {
      if (buffered.length > 65536) refuse('header too large');
      return;
    }
    let header;
    try {
      header = JSON.parse(buffered.subarray(0, newline).toString());
    } catch {
      return refuse('bad header');
    }
    const rest = buffered.subarray(newline + 1);
    const plan = authorize(header);
    if (typeof plan === 'string') return refuse(plan);
    try {
      if (plan.create) {
        mkdirSync(plan.cwd, { recursive: true, mode: 0o700 });
        if (root) chownSync(plan.cwd, plan.uid, plan.gid);
      }
      child = spawn(plan.file, plan.args, {
        cwd: plan.cwd,
        env: { ...baseEnv, HOME: plan.home, HOSTNAME: `nod-${mode}` },
        ...(root ? { uid: plan.uid, gid: plan.gid } : {}),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return refuse(`spawn failed: ${error.message}`);
    }
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => socket.write(frame(1, d)));
    child.stderr.on('data', (d) => socket.write(frame(2, d)));
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      socket.end(Buffer.concat([frame(2, Buffer.from(`nod-relay: ${error.message}\n`)), exitFrame(127)]));
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      const signals = { SIGKILL: 9, SIGTERM: 15, SIGINT: 2 };
      socket.end(exitFrame(code ?? 128 + (signals[signal] ?? 1)));
    });
    if (rest.length) child.stdin.write(rest);
  };
  socket.on('data', onData);
  socket.on('end', () => child?.stdin.end());
  socket.on('error', () => {});
  socket.on('close', () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  });
});

server.listen({ port, host: '::', ipv6Only: false }, () => {
  console.log(`nod-relay-agent (${mode}) listening on [::]:${port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
