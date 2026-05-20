# Project Instructions

## Environment

This is the **WebDB Playground** — a Docker Compose environment running inside the
`nocodenation_playground_network`. All services below are reachable from this
container by their Docker service name.

---

## Services

| Service | Internal URL | Purpose |
|---|---|---|
| `postgres` | `postgres:5432` | Main PostgreSQL 17 database (pgvector). User: `api_user`, DB: `postgres` |
| `postgrest_app` | `http://postgrest_app:3000` | PostgREST — REST API auto-generated from the `public` schema |
| `pgadmin` | `http://pgadmin:80` | pgAdmin 4 web UI |
| `proxy` | `http://proxy:80` (pgAdmin), `http://proxy:81` (PostgREST) | nginx reverse proxy |
| `swagger` | `http://swagger:8080` | Swagger UI for PostgREST OpenAPI spec |

External ports on the host: pgAdmin → 8100, PostgREST → 8101, Swagger → 8102, OpenCode → 8103.

---

## Authentication

All PostgREST requests require a JWT bearer token. It is available as an environment variable:

```bash
echo $POSTGREST_API_KEY
```

Use it as: `Authorization: Bearer <token>`

---

## PostgREST API

### Fetch the OpenAPI spec

Always fetch the live spec before constructing any request — it reflects the current
database schema including all user-created tables and functions.

```bash
curl -s http://postgrest_app:3000/ \
  -H "Authorization: Bearer <token>" \
  -H "Accept: application/json"
```

### Call an RPC function

```bash
curl -s -X POST http://postgrest_app:3000/rpc/<function_name> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ ...params... }'
```

### Query a table

```bash
curl -s http://postgrest_app:3000/<table_name> \
  -H "Authorization: Bearer <token>"
```

---

## Built-in RPC Functions

### `create_table` — create a new table

```bash
curl -s -X POST http://postgrest_app:3000/rpc/create_table \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "p_table_name": "my_table",
    "p_columns": {"id": "seqnumber", "name": "string", "score": "number", "created_at": "datetime"},
    "p_primary_keys": ["id"]
  }'
```

Supported column types: `string` → text, `number` → numeric, `datetime` → timestamp,
`vector` → vector(768), `seqnumber` → numeric with auto-increment sequence.

### `create_vector_index` — add an HNSW index on a vector column

```bash
curl -s -X POST http://postgrest_app:3000/rpc/create_vector_index \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"p_table_name": "my_table", "p_embedding_column_name": "embedding"}'
```

### `deploy_function` — create or replace a PostgreSQL function and expose it via PostgREST

This is the primary way to add new database functions at runtime without direct DB access.
The new function is immediately available as `POST /rpc/<function_name>`.

```bash
curl -s -X POST http://postgrest_app:3000/rpc/deploy_function \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "function_name": "my_function",
    "function_params": "p_input text",
    "return_type": "jsonb",
    "function_language": "plpgsql",
    "function_body": "BEGIN\n  RETURN jsonb_build_object(''result'', p_input);\nEND;",
    "replace_existing": true
  }'
```

Constraints: `function_name` must be lowercase alphanumeric + underscores; only
`plpgsql` and `sql` languages are allowed. The new function is automatically owned
by `api_user` so PostgREST exposes it immediately (schema reload is automatic via
the `pgrst_watch` event trigger).

**Workflow when asked to "create a function":**
1. Fetch the OpenAPI spec to understand existing tables and types.
2. Draft the function body.
3. Call `deploy_function` to create it.
4. Verify by calling the new endpoint: `POST /rpc/<function_name>`.

---

## Logs

When asked about logs for any service, check `/logs`:

| Path               | Service                                                                            |
|--------------------|------------------------------------------------------------------------------------|
| `/logs/postgres`   | PostgreSQL                                                                         |
| `/logs/pgadmin_db` | pgAdmin metadata database                                                          |
| `/logs/pgadmin`    | pgAdmin web UI                                                                     |
| `/logs/proxy`      | nginx reverse proxy                                                                |
| `/logs/swagger`    | Swagger UI                                                                         |
| `/logs/bun_runner` | Bun Runner (Node Application, Bun Application, UI, Bun UI, Built Application) logs |

---

## Application

When asked to create or update application, UI, node app, bun app or somentring like that - create an SSR React application and put that into `/app` folder.
Each edit should increase "version" in `package.json` file of that app.
If user asks about issues of the application check logs located in `/logs/bun_runner` the see issues with installing dependencies, building application or running application

