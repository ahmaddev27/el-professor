/*
  The minimum of Supabase Storage that a migration adding a bucket or storage
  policies needs in order to apply.

  The fixture is a --schema=public dump, and the bare supabase/postgres image
  has no storage schema at all: storage-api creates it when the service starts.
  So without this, a migration that inserts into storage.buckets or creates a
  policy on storage.objects fails in the kit even though it applies cleanly on
  staging and production.

  Column shapes, grants and foldername() are copied from staging's live storage
  schema (read 2026-09-14). The prefix triggers and storage.prefixes are left
  out: they maintain a search index and play no part in who may read or write.
  Nothing in this file is under test — the policies migrations create on top of
  it are.
*/
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  owner              uuid,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  public             boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  owner_id           text
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        text REFERENCES storage.buckets(id),
  name             text,
  owner            uuid,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata         jsonb,
  path_tokens      text[],
  version          text,
  owner_id         text,
  user_metadata    jsonb,
  level            integer
);

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[]
LANGUAGE plpgsql
AS $function$
DECLARE
_parts text[];
BEGIN
	select string_to_array(name, '/') into _parts;
	return _parts[1:array_length(_parts,1)-1];
END
$function$;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.buckets TO anon, authenticated, service_role;
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO anon, authenticated, service_role;
