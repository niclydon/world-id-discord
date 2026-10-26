<img src="./public/images/logo.png" alt="World ID Discord Bot logo" width="100" />

# Discord x Worldcoin

This project is a demonstration of serverless Discord Bot that uses [IDKit](https://github.com/worldcoin/idkit) to verify humans. Verified humans get a special role assigned which can then be used to manage special permissions.

## World ID 4 configuration

The bot verifies against a World ID 4.0 relying party (RP):

1. Register an app in the [Developer Portal](https://developer.world.org) and create a managed RP for it. Note the app id (`app_...`) and the RP id (`rp_...`).
2. Set `NEXT_PUBLIC_APP_ID` to the app id and `NEXT_PUBLIC_RP_ID` to the RP id.
3. Set `RP_SIGNING_KEY` to the RP signing key (hex). The key is generated in the Developer Portal when the RP is created and is shown only once. It is used server side only, to sign proof requests; never expose it to the client.
4. Actions are created automatically on first verification, using the action description the widget sends. There is no separate action registration step.
5. Set `NEXT_PUBLIC_WORLD_ID_ENVIRONMENT` to `production`, `staging`, or `sandbox`; it defaults to `production`. The server rejects a missing or mismatched proof environment before restoring roles or verifying a proof, pins the forwarded request to the configured environment, and checks the Developer Portal response. Use `staging` only for Simulator testing.

`NEXT_PUBLIC_APP_ID` alone is deprecated as the verification identifier: the verify endpoint still accepts it as a fallback for migrated apps for one release (a deprecation warning is logged), but the RP context endpoint requires `NEXT_PUBLIC_RP_ID` and `RP_SIGNING_KEY`, so new deployments must set all three variables.

See `@types/env.d.ts` for the full list of environment variables.

## Self-hosted Discord integration API

Bot configs and verification results are persisted through a small
"Discord integration API" that the app calls server side (see
`lib/discord-integration-api`). This repo ships a self-hosted stand-in
for that API as route handlers in the same app, so a deployment does
not depend on an external backend:

- `GET`/`POST /discord/bot-config`
- `GET`/`POST /discord/verification-result`

The client builds these URLs with an absolute path, so the routes live
at the app root and only the scheme and host of
`DISCORD_INTEGRATION_API_URL` matter. To use the stand-in, point the
variable at the deployment itself, for example
`https://your-app.vercel.app`, and set
`DISCORD_INTEGRATION_API_SIGN_SECRET` to a random secret. Requests are
authorized with the short-lived HS256 JWT the client signs with that
secret (subject `discord-integration`, the app URL as issuer, the
integration API URL as audience); the stand-in verifies the same
claims and rejects anything else.

The integration API requires Postgres through `INTEGRATION_API_DATABASE_URL` or
`DATABASE_URL` (on Vercel, connecting a Neon database to the project injects
`DATABASE_URL`; tables are created on first use). Without either URL,
integration API requests fail closed and cannot grant roles. Development and
tests can explicitly opt into a JSON file (`INTEGRATION_API_ALLOW_LOCAL_STORE=true`
and `INTEGRATION_API_STORE_FILE`, or a file in the OS temp directory). The local
store is disabled on Vercel, whenever `NEXT_PUBLIC_APP_ENV` is not `development`,
and whenever `NODE_ENV` is absent or production.
File storage is limited to one process; it does not enforce ownership across
processes or serverless instances.

Verification results are immutable by guild and nullifier: exact retries
succeed, while a different Discord user, credential type, or World ID
environment receives a `409` conflict and cannot replace the existing record.
Rows written by older versions without an environment fail closed for role
restoration and need an explicit, verified migration.

The store initializes its tables under a transaction-scoped advisory lock so
simultaneous cold starts cannot race PostgreSQL catalog creation. To rehearse
the migration and nullifier ownership rule against a disposable PostgreSQL
16/17 database, set `DISCORD_POSTGRES_TEST_URL` to that database's connection
URL and run `pnpm exec vitest run server/integration-api/store.postgres.test.ts`.
The test creates and drops uniquely named schemas. It executes the store's
production SQL over a PostgreSQL wire connection; it does not validate the
hosted Neon HTTP transport or deployment credentials.

## Local development

For local development, you also will need [ngrok](https://ngrok.com/). After you log in, you can reach the [Setup & Installation](https://dashboard.ngrok.com/get-started/setup) section. There is an instruction on how to launch and configure `ngrok`

To create your own bot:

1. Clone repo.
2. Run `npm install`.
3. Run `npm run dev`. It will launch the app at `http://localhost:3000`.
4. Launch `ngrok`.
5. Run `ngrok http http://localhost:3000`.
6. After this ngrok shows you your tunneled link in the `Forwarding` field. It will be something like `https://9469-93-87-199-13.eu.ngrok.io`.
7. Go to [Discord Developer Portal](https://discord.com/developers).
8. Press the `New Application` button, set the app name, apply policies, and press `Create`.
9. At the `INTERACTIONS ENDPOINT URL` field paste.
   `<Your NGROK tunneled url>/api/interactions` and press `Save`.
10. Create a `.env.local` file in your directory and fill it with envs from `@/types/env.d.ts`.
11. `APPLICATION ID` and `PUBLIC KEY` you can find in the `General Information` section on Discord Dev Portal.
12. To get a bot token:
    - go to the `Bot` section
    - Press `Reset Token`
    - Token will be visible after this
13. Go to OAuth2 -> General -> Redirects -> add `<localhost or NGROK tunneled address>/api/auth/callback/discord`
14. On the landing page press `Install now` button.
15. Install bot.
16. Try the `/verify` command.
