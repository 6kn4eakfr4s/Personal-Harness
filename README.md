# Personal-Harness

This is my personal Harness. It's currently in development.

## Development

Use the Node.js version in `.nvmrc` and the npm version declared in
`package.json#packageManager`.

```sh
npm ci
npm run typecheck
npm run check
npm test
npm run build
```

The repository is an npm workspace with three packages:

| Directory | Package | Contents |
|---|---|---|
| `protocol/` | `@personal-harness/protocol` | Types shared by the backend and the web client. |
| `backend/` | `@personal-harness/backend` | The agent service and a CLI for manual testing. |
| `web/` | `@personal-harness/web` | The web client. |

## Continuous integration

GitHub Actions runs type checks, Biome checks, tests, and the build on pull
requests targeting `main` and pushes to `main`, using the project's configured
Node.js and npm versions.
