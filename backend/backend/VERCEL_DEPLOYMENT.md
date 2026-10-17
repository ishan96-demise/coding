# Fin Sentinels cloud deployment

## Deployment shape

Deploy the Next.js analyst interface to Vercel. Run FastAPI, the PyTorch GNN, and the writable investigation data directory as a Docker service with one persistent volume. The Vercel project calls the API over HTTPS.

This keeps the graph model in a normal Python process and gives cases, settings, ingested transactions, and evidence files durable storage. Vercel functions have a 4.5 MB request-body limit and an ephemeral writable filesystem; Fin Sentinels accepts evidence files up to 10 MB and writes investigation state. The direct-upload route uses a short-lived token scoped to one case, so files go from the browser to the API service without sending the file through a Vercel function.

The repository also contains `vercel.json` for an experimental Python Function deployment. Do not use `backend/backend` as the Vercel website's root directory: it deploys the API function rather than the Next.js terminal, and its serverless temporary storage is not durable.

## Deploy the API container

Build from `backend/backend` using the included `Dockerfile`. Configure the service to expose its assigned `PORT`, and attach a persistent disk mounted at `/var/lib/finsentinels`. The container sets `FINSENTINELS_RUNTIME_DIR` to that mount; packaged read-only seed data remains in `/app/data`.

Set these environment variables in the container host's secret/environment settings:

| Variable | Value |
| --- | --- |
| `FIN_SENTINELS_BACKEND_API_KEY` | Random secret of at least 32 characters; set the same value on Vercel. |
| `FIN_SENTINELS_UPLOAD_SECRET` | A different random secret of at least 32 characters; set the same value on Vercel. |
| `FIN_SENTINELS_FRONTEND_URL` | The production Vercel URL, such as `https://your-terminal.vercel.app/`. |
| `FIN_SENTINELS_ALLOWED_ORIGINS` | The frontend origin(s), comma-separated, with no path. Include the production Vercel origin. |
| `FINSENTINELS_RUNTIME_DIR` | `/var/lib/finsentinels`; this directory must be on the persistent disk. |
| `OBP_*` | Optional provider credentials and webhook settings from `OBP_ENV.example`. Leave unset until an authorized bank sandbox is configured. |

Expose the API through HTTPS. All `/api` routes require the backend API key except the OBP webhook (which verifies its signature) and the exact evidence-upload route (which requires a short-lived, case-scoped HMAC token). Restrict access at the host/network layer where practical, while allowing the Vercel server runtime and browser upload requests to reach it. The signed OBP webhook also needs a public HTTPS callback URL if the provider is connected.

## Deploy the Next.js interface to Vercel

1. Import `ishan96-demise/coding` as a Vercel project.
2. Set **Root Directory** to `backend/backend/frontend`.
3. Keep the detected Next.js framework and `pnpm` package manager. Use `pnpm install --frozen-lockfile` and `pnpm build` if custom build commands are required.
4. Add these Production environment variables. Add Preview values separately if you intend to enable preview deployments.

| Variable | Value |
| --- | --- |
| `FIN_API_INTERNAL_URL` | Public HTTPS base URL of the FastAPI service, without `/api`. |
| `FIN_API_PUBLIC_URL` | The same public HTTPS API base URL; used by the browser only for evidence uploads. |
| `FIN_SENTINELS_BACKEND_API_KEY` | The same random key configured on the FastAPI service. |
| `FIN_SENTINELS_UPLOAD_SECRET` | The same upload-signing secret configured on the FastAPI service. |
| `FIN_SENTINELS_USERNAME` | Analyst login name. |
| `FIN_SENTINELS_PASSWORD` | A unique strong password; it is never stored in Git. |
| `FIN_SENTINELS_SESSION_SECRET` | A separate random secret, at least 32 characters. |
| `NEXT_PUBLIC_FIN_DIRECT_UPLOAD` | `true` to upload evidence directly to the API service and retain the 10 MB limit. |

After the first successful deployment, add its exact HTTPS origin to `FIN_SENTINELS_FRONTEND_URL` and `FIN_SENTINELS_ALLOWED_ORIGINS` on the API service, then redeploy the API if the values changed.

## Local deployment checks

From `backend/backend`, build the API image with `docker build -t fin-sentinels-api .`. Run it with a persistent Docker volume mounted at `/var/lib/finsentinels`, the required auth secrets, and a reachable Next.js URL. The usual local Python and Next.js commands in `README.md` remain available.

Do not put credentials, real transaction payloads, analyst evidence, or provider tokens in Git or in `NEXT_PUBLIC_*` variables. The direct upload token is short-lived, case-scoped, and generated only after the analyst session is checked.

## Current scale boundary

The JSON-backed runtime store is intended for one API instance with one persistent volume. Do not add API replicas that each have a separate disk. Before multi-instance or multi-analyst production use, move case/settings/transaction state to shared PostgreSQL and evidence files to private object storage. Vercel can host Python Functions and now has a Large Functions beta, but this deployment keeps the GNN and durable file writes together until that shared-store migration is implemented.
