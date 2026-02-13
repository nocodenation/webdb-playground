-- Create users
CREATE ROLE api_anon nologin;

CREATE ROLE authenticator WITH NOINHERIT LOGIN PASSWORD 'authenticator_password';

GRANT api_anon TO authenticator;

GRANT USAGE on SCHEMA public to api_anon;

GRANT ALL on schema public to api_user;

GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO api_user;

-- Create an event trigger function
CREATE OR REPLACE FUNCTION pgrst_watch() RETURNS event_trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
END;
$$;

-- This event trigger will fire after every ddl_command_end event
CREATE EVENT TRIGGER pgrst_watch
  ON ddl_command_end
  EXECUTE PROCEDURE pgrst_watch();



-- Function: create_table
-- Accepts a JSON/JSONB definition of a table and creates it in the public schema.
-- The created table will be owned by role api_user.
-- Expected JSON structure:
-- {
--   "table_name": "Table Name",
--   "columns": {"col1": "string", "col2": "number", "col3": "datetime"},
--   "primary_keys": ["col1"]
-- }
CREATE OR REPLACE FUNCTION public.create_table(p_table_name text, p_columns json, p_primary_keys text[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
v_table_name text;
  v_columns json;
  v_cols_sql text := '';
  v_sql text;
  v_key text;
  v_val text;
  v_pgtype text;
  v_seq_cols text[] := '{}'::text[]; -- columns that require sequences
  v_seq_name text;
BEGIN
  -- Validate and extract table name
  v_table_name := trim(both from p_table_name);
  IF v_table_name IS NULL OR v_table_name = '' THEN
    RAISE EXCEPTION 'Table name (name) is required in JSON definition';
END IF;

  -- Validate and extract columns object
  v_columns := p_columns;
  IF v_columns IS NULL OR json_typeof(v_columns) <> 'object' THEN
    RAISE EXCEPTION 'columns must be a JSON object of name:type pairs';
END IF;

  -- Build columns SQL in the same order as provided in JSON (create only columns passed by the user)
FOR v_key, v_val IN
SELECT key, value FROM json_each_text(v_columns)
    LOOP
    CASE lower(v_val)
    WHEN 'string'     THEN v_pgtype := 'text';
WHEN 'number'     THEN v_pgtype := 'numeric';
WHEN 'datetime'   THEN v_pgtype := 'timestamp';
WHEN 'vector'     THEN v_pgtype := 'vector(768)';
WHEN 'seqnumber'  THEN v_pgtype := 'numeric';
ELSE RAISE EXCEPTION 'Unsupported type "%" for column "%". Supported: string, number, datetime, vector, seqnumber', v_val, v_key;
END CASE;

    IF lower(v_val) = 'seqnumber' THEN
      -- mark this column to attach a sequence after table creation
      v_seq_cols := array_append(v_seq_cols, v_key);
END IF;

    IF v_cols_sql <> '' THEN
      v_cols_sql := v_cols_sql || ', ';
END IF;
    v_cols_sql := v_cols_sql || format('%s %s', quote_ident(v_key), v_pgtype);
END LOOP;

  -- Apply primary keys from p_primary_keys if provided
  IF p_primary_keys IS NOT NULL AND array_length(p_primary_keys, 1) IS NOT NULL AND array_length(p_primary_keys, 1) > 0 THEN
    v_cols_sql := v_cols_sql || format(', PRIMARY KEY (%s)', (
      SELECT string_agg(quote_ident(col), ', ')
      FROM unnest(p_primary_keys) AS t(col)
    ));
END IF;

  -- Compose and execute CREATE TABLE
  v_sql := format('CREATE TABLE %s (%s);', quote_ident(v_table_name), v_cols_sql);
EXECUTE v_sql;

-- Set owner to api_user
EXECUTE format('ALTER TABLE %s OWNER TO api_user;', quote_ident(v_table_name));

-- Create sequences and defaults for seqnumber columns
IF array_length(v_seq_cols, 1) IS NOT NULL THEN
    FOREACH v_key IN ARRAY v_seq_cols LOOP
      v_seq_name := format('%s_%s_seq', v_table_name, v_key);
      -- Ensure sequence exists
EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I.%I', 'public', v_seq_name);
-- Link sequence ownership to the column so it is dropped with the column
EXECUTE format('ALTER SEQUENCE %I.%I OWNED BY %I.%I.%I', 'public', v_seq_name, 'public', v_table_name, v_key);
-- Set default to nextval of the sequence
EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT nextval(%L)', 'public', v_table_name, v_key, format('%I.%I', 'public', v_seq_name));
END LOOP;
END IF;
END;
$$;

-- Function: create_vector_index
-- Create index for a pgvector db
-- The created table will be owned by role api_user.
-- Expected JSON structure:
-- {
--   "table_name": "Table Name",
--   "embedding_column_name": "A column name that contains embedding",
-- }
CREATE OR REPLACE FUNCTION public.create_vector_index(p_table_name text, p_embedding_column_name text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
v_schema text := 'public';
  v_idx_name text;
BEGIN
  -- Construct index name: <table>_embedding_idx
  v_idx_name := format('%s_embedding_idx', p_table_name);

  -- Create the index if it doesn't exist yet
  IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = v_idx_name AND n.nspname = v_schema
  ) THEN
      EXECUTE format(
          'CREATE INDEX %I ON %I.%I USING hnsw (%I vector_l2_ops) WITH (m = 4, ef_construction = 10)',
          v_idx_name, v_schema, p_table_name, p_embedding_column_name
      );
END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE EXCEPTION 'Table %.% does not exist', v_schema, p_table_name;
WHEN undefined_column THEN
    RAISE EXCEPTION 'Column % does not exists on table %.%', p_embedding_column_name, v_schema, p_table_name;
END;
$$;


CREATE OR REPLACE FUNCTION public.deploy_function(
    function_name TEXT,
    function_body TEXT,
    function_params TEXT DEFAULT '',
    return_type TEXT DEFAULT 'JSONB',
    function_language TEXT DEFAULT 'plpgsql',
    replace_existing BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
full_function_name TEXT;
    create_statement TEXT;
    result JSONB;
BEGIN
    -- Validate function name (basic security check)
    IF function_name !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'Invalid function name: must be lowercase alphanumeric with underscores';
END IF;

    -- Validate language
    IF function_language NOT IN ('plpgsql', 'sql') THEN
        RAISE EXCEPTION 'Only plpgsql and sql languages are allowed';
END IF;

    -- Build the full function name in public schema
    full_function_name := 'public.' || function_name;

    -- Build the CREATE FUNCTION statement
    create_statement := format(
        'CREATE %s FUNCTION %s(%s) RETURNS %s LANGUAGE %s AS %L',
        CASE WHEN replace_existing THEN 'OR REPLACE' ELSE '' END,
        full_function_name,
        function_params,
        return_type,
        function_language,
        function_body
    );

    -- Execute the dynamic SQL
EXECUTE create_statement;

-- Change owner to api_user so it gets exposed via PostgREST
EXECUTE format('ALTER FUNCTION %s OWNER TO api_user', full_function_name);

-- Return success info
result := jsonb_build_object(
        'success', TRUE,
        'function_name', full_function_name,
        'endpoint', 'https://rest.mywebdb.liquid.mx/rpc/' || function_name,
        'created_at', NOW()
    );

RETURN result;

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', FALSE,
        'error', SQLERRM,
        'function_name', function_name
    );
END;
$$;

ALTER FUNCTION public.deploy_function OWNER TO api_user;


CREATE EXTENSION vector;
