-- 0007 — Add an indexed pgvector column where the extension exists.
--
-- real[] in 0004 is the storage of record and works everywhere. On Supabase,
-- pgvector is available and semantic search should use it; on the local test
-- database it is not, and VectorStore falls back to cosine similarity in SQL
-- (ADR 0005).
--
-- Both paths run regularly — pgvector every dev session, the array fallback
-- every CI run — so neither can quietly rot.

DO $outer$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE NOTICE 'pgvector absent — embeddings stay on the real[] fallback';
    RETURN;
  END IF;

  -- 1024 dimensions covers the embedding models we route to. A model with a
  -- different width is a different row set (embeddings is keyed by model_id),
  -- not a silent reinterpretation of existing vectors.
  ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS embedding_v vector(1024);

  -- Keep the vector column in step with the array of record.
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION app.sync_embedding_vector() RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      IF NEW.dimensions = 1024 THEN
        NEW.embedding_v := NEW.embedding::vector(1024);
      ELSE
        NEW.embedding_v := NULL;
      END IF;
      RETURN NEW;
    END
    $body$;
  $fn$;

  DROP TRIGGER IF EXISTS embeddings_sync_vector ON embeddings;
  CREATE TRIGGER embeddings_sync_vector
    BEFORE INSERT OR UPDATE OF embedding, dimensions ON embeddings
    FOR EACH ROW EXECUTE FUNCTION app.sync_embedding_vector();

  -- HNSW: better recall/latency than ivfflat at this scale, and it does not
  -- need a training pass over existing rows before it is useful.
  CREATE INDEX IF NOT EXISTS embeddings_vector_idx
    ON embeddings USING hnsw (embedding_v vector_cosine_ops);

EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pgvector column setup skipped: %', SQLERRM;
END
$outer$;
