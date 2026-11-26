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

The repository is an npm workspace. The backend package lives in `backend/`:
its TypeScript source is in `backend/src/` and compiles to `backend/dist/`.
Root scripts run across all workspaces. Biome handles linting and formatting;
use `npm run format` to format code.

Tests use Vitest, with `*.test.ts` files alongside source files.
`npm run test:watch -w @personal-harness/backend` enables watch mode.

## Continuous integration

GitHub Actions runs type checks, Biome checks, tests, and the build on pull
requests targeting `main` and pushes to `main`, using the project's configured
Node.js and npm versions.
