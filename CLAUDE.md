# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WebDB Playground is a Docker Compose-based local development environment providing a PostgreSQL database with PostgREST API, pgAdmin web UI, and Swagger API docs. It is an infrastructure-only project with no application code — all configuration is declarative (SQL, YAML, Python config, JSON).

## Architecture

Five services on a shared `nocodenation_playground_network`:

- **postgres** (`pgvector/pgvector:pg17`) — Main database with pgvector extension. User `api_user`, anonymous role `api_anon`. Port 5432 (internal only).
- **pgadmin_db** (`postgres:17`) — Separate Postgres instance backing pgAdmin's internal metadata.
- **pgadmin** (`dpage/pgadmin4`) — Web UI for database management. Exposed on **port 8100**. Uses custom webserver authentication (`X-Authentication-Email` header) with auto-user-creation — no password login.
- **postgrest** (`postgrest/postgrest`) — Auto-generated REST API from the Postgres schema. Exposed on **port 8101**. Uses JWT auth via `PGRST_JWT_SECRET`.
- **swagger** (`swaggerapi/swagger-ui`) — API documentation UI. Exposed on **port 8102**. Reads OpenAPI spec from PostgREST.

## Key Files

- `compose.yml` — Service definitions. Uses `{{ placeholder }}` template variables for secrets (`DATABASE_PASSWORD`, `PGADMIN_DATABASE_PASSWORD`, `REST_BEARER_TOKEN`).
- `config/postgres/init-db.sql` — Main DB initialization: roles (`api_anon`, `authenticator`), schema reload trigger (`pgrst_watch`), `create_table()` RPC function (supports types: string, number, datetime, vector, seqnumber), `create_vector_index()` RPC function, and pgvector extension.
- `config/pgadmin_db/init-db.sql` — pgAdmin DB initialization: trigger to set default file upload size preference for new users.
- `config/pgadmin/` — pgAdmin configuration: `config_local.py` (webserver auth, CSRF disabled), `webserver.py` (custom Flask auth module with auto-create user, server import on first login), `servers.json` (pre-configured server connection), `pgpass` (password file for auto-connect).
- `config/pgadmin/templates/` — Template files: `config_distro.py` (DB URI with placeholder), `pgpass`.

## Commands

```bash
# Start all services
docker compose up -d

# Stop all services
docker compose down

# View logs
docker compose logs -f [service_name]

# Rebuild after config changes
docker compose up -d --force-recreate
```

## Template Variables

The `compose.yml` and config files use `{{ placeholder }}` syntax for secrets. These must be substituted before deployment:
- `{{ DATABASE_PASSWORD }}` — Main Postgres password for `api_user`
- `{{ PGADMIN_DATABASE_PASSWORD }}` — pgAdmin metadata DB password
- `{{ REST_BEARER_TOKEN }}` — JWT secret for PostgREST authentication

## Database Schema Design

Tables are created dynamically via the `create_table()` PostgREST RPC function. Supported column types map to Postgres types:
- `string` → `text`
- `number` → `numeric`
- `datetime` → `timestamp`
- `vector` → `vector(768)` (pgvector)
- `seqnumber` → `numeric` with auto-increment sequence

All created tables are owned by `api_user` and accessible via PostgREST's REST API. Schema changes auto-notify PostgREST to reload via the `pgrst_watch` event trigger.
