# Personal-Harness

This is my personal Harness. It's currently in development.

## Running the CLI

### Credentials

`pi-ai` reads credentials from the environment. The example template uses
Vertex AI, which takes either:

- an API key in `GOOGLE_CLOUD_API_KEY`, or
- Application Default Credentials:

  ```sh
  gcloud auth application-default login
  export GOOGLE_CLOUD_PROJECT="my-project"
  export GOOGLE_CLOUD_LOCATION="global"
  ```

For other providers, see "Environment Variables" in the
[`pi-ai` README](https://www.npmjs.com/package/@earendil-works/pi-ai).

### Starting

```sh
npm run cli
npm run cli -- --template assistant
```

Arguments after `--` go to the CLI. Each `.json` file in `templates/` is one
agent; `--template` is required only when there is more than one.

- **Ctrl+C**: cancel a reply or clear the line; twice on an empty line to
  exit.
- **Ctrl+D**: exit.

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

TypeScript source lives in `src/` and compiles to `dist/`. Biome handles linting
and formatting; use `npm run format` to format code.

Tests use Vitest, with `*.test.ts` files alongside source files.
`npm run test:watch` enables watch mode.

## Continuous integration

GitHub Actions runs type checks, Biome checks, tests, and the build on pull
requests targeting `main` and pushes to `main`, using the project's configured
Node.js and npm versions.
