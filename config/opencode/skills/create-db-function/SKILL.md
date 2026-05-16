---
name: create-db-function
description: Deploy a new PostgreSQL function and expose it via the PostgREST REST API
---

## What I do

Given a description of what a database function should do, I will:

1. Read the API key from `/workspace/.env`
2. Fetch the live OpenAPI spec from PostgREST to understand existing tables and types
3. Write a `plpgsql` or `sql` function body that satisfies the request
4. Call `deploy_function` to create/replace the function in PostgreSQL
5. Verify the new endpoint responds correctly

## Steps

### 1. Read the API key
```bash
API_KEY=$(grep '^API_KEY=' /workspace/.env | cut -d'=' -f2-)
```

### 2. Fetch the live OpenAPI spec
```bash
curl -s http://postgrest_app:3000/ \
  -H "Authorization: Bearer $API_KEY" \
  -H "Accept: application/json"
```
Inspect the `definitions` and `paths` sections to understand available tables and existing RPC functions before writing any code.

### 3. Deploy the function
```bash
curl -s -X POST http://postgrest_app:3000/rpc/deploy_function \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "function_name": "<snake_case_name>",
    "function_params": "<param1> <type1>, <param2> <type2>",
    "return_type": "jsonb",
    "function_language": "plpgsql",
    "function_body": "<escaped function body>",
    "replace_existing": true
  }'
```

Rules for `function_body`:
- Write the body between `BEGIN` and `END;` — do not include `CREATE FUNCTION` or `$$` delimiters
- Escape single quotes by doubling them: `'value'` → `''value''`
- `function_name` must be lowercase alphanumeric with underscores only
- Only `plpgsql` and `sql` languages are allowed

### 4. Verify
Call the new endpoint with representative input and confirm the response is correct:
```bash
curl -s -X POST http://postgrest_app:3000/rpc/<function_name> \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "<param1>": "<test_value>" }'
```

## Rules

- Always fetch the OpenAPI spec first — never assume table names or column types
- Prefer `RETURNS jsonb` so callers get structured output
- Use `RETURNS SETOF <table>` when the function is meant to return rows from an existing table
- If the request is ambiguous, ask one clarifying question before writing any code
