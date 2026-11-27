# Nod on Railway

Railway template for [Nod](https://github.com/n8n-io/nod) 0.10.0, the personal agent from n8n labs. It has its own Linux workspace and Chromium.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/nod)

The deployer guide is in [TEMPLATE_OVERVIEW.md](TEMPLATE_OVERVIEW.md). The build sheet, with the reasoning behind each choice, is in [template.json](template.json).

## How it works

Upstream's server drives the workspace and browser containers only through `docker exec -i`. Railway has no Docker socket, so:

- `relay/docker` replaces the docker CLI in the server image. It forwards exactly those two exec shapes to the matching service.
- `relay/nod-relay-agent.mjs` runs as root in Workspace and Browser. It checks a shared token and applies upstream `docker-proxy.mjs`'s allow rules. It drops to the right uid and returns stdio and the exit code.
- `images/` wraps upstream's own Dockerfiles. `.github/workflows/images.yml` builds them at the tag in `NOD_VERSION` and pushes `ghcr.io/robertsinke/nod-railway-{server,workspace,browser}`.

## Tests

- `node --test test/relay.test.mjs`: relay contract (stdio, exit codes, token, workdir and command allow rules, env scrubbing, open-stdin exit).
- `test/compose.yaml`: the Railway topology locally, with no Docker socket.
- `e2e.py <url> <token-file> --connect ANTHROPIC_API_KEY`: a real agent turn that runs a workspace command, writes a file and reads a page in the browser.

## Upgrading Nod

Bump `NOD_VERSION`, push, wait for the images workflow, then update the image tags in `template.json` and run `upsert.py`.
