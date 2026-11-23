# @viateai/plugin-grok

Viate provider for a Grok subscription. Provider id: `grok`.

This is separate from `@viateai/plugin-xai-oauth`, which sends a Grok CLI OAuth token to `https://api.x.ai/v1`. `grok` signs in with the Grok CLI device flow and sends chat to `https://cli-chat-proxy.grok.com/v1`.

The gateway speaks OpenAI chat completions and responses. Chat completions are translated onto `POST /responses` and translated back. Native responses are forwarded to the same proxy. `listModels` calls `GET /models` on that host.

## Connection

Device-code OAuth uses the public Grok CLI client `b1a00492-073a-47ea-816f-4c329264a828` on `https://auth.x.ai`. There is no client secret. The admin dialog shows the user code and verification URL, then polls the token endpoint.

A pasted credential also works. A raw string is the access token. JSON accepts a Grok `auth.json` entry (`key`, `refresh_token`) or `access_token` / `accessToken` and `refresh_token` / `refreshToken`.

Requests identify as `grok-shell/1.0.46` with `x-xai-token-auth: xai-grok-cli`. The proxy rejects `x-grok-client-version` below `1.0.13`.

`keepalive` refreshes the access token five minutes before `expiresAt`. Without `expiresAt`, the next check is one hour later.

## Install

This package is not published to npm. Clone the repository, compile it, and install that directory. `viate.entry` is `dist/index.js`, and `dist/` is not in git. The installer runs with `ignore-scripts=true`, so it will not compile the package for you.

Node.js >= 24. pnpm 12.16.1, pinned by `packageManager`.

```bash
git clone https://github.com/ViateAI/viate-plugin-grok.git
cd viate-plugin-grok
pnpm install
pnpm build
viate plugin add "$PWD"
```

`$PWD` is passed to `pnpm add` by the `viate` process. From the admin plugin source field, use the same directory as an absolute path that process can read.

`@viateai/sdk` is a peer of `1.0.1`; the gateway removes it at install and loads its own copy. `plugin add` stages a pending workspace. Restart the gateway to load it.

To install a newer checkout, pull, run `pnpm install` and `pnpm build` again, then `viate plugin add "$PWD"` again, and restart.

Plugins run in-process. Install only packages you trust. See [Viate](https://github.com/ViateAI/viate).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Release Please on `main` owns the version and changelog. Do not edit either by hand.

MIT. See [LICENSE](LICENSE).
