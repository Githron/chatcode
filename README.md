# ChatCode

ChatCode is an account-free browser messenger. Anyone with the same room code can join, read the latest 100 messages, reply and share files. Names are self-selected. Use a hard-to-guess code for private conversations.

## Local development

Use Node.js 22 or later. Run the following from the project directory.

```sh
npm ci
npm test
CHATCODE_MEDIA_BACKEND=database npm start
```

Open http://localhost:3000. Express serves the browser modules directly from `public/`. Development uses an on-disk embedded PostgreSQL database (PGlite) in the gitignored `.chatcode-data/` directory unless `DATABASE_URL` or `PGHOST` points to an existing PostgreSQL server. Set `CHATCODE_DATA_DIR` to choose another private directory outside the web root. Run one server per data directory.

`npm test` creates a temporary PGlite database and exercises the real SDK against a local mock object store with fixture credentials, including outages and restarts. To exercise the production driver, set `CHATCODE_TEST_DATABASE_URL` to an empty, disposable PostgreSQL database. The quota tests deliberately exhaust a small service-wide budget.

## Deploy on Render

1. Use an existing durable PostgreSQL database, or create a Render Postgres instance in the same region as the web service. Select a plan with the retention and backup period you need.
2. In the web service's **Environment** settings, set **DATABASE_URL** to the database's internal connection URL. Keep the URL in Render's secret settings. The PostgreSQL role needs permission to create and use the three `chatcode_*` tables and their indexes and sequence. Tables are initialized before the app starts listening.
3. Use Node.js 22 or later, build with `npm ci`, start with `npm start`, and keep the health check at `/ping`. Deploy one web-service instance. Socket.IO presence, ordered live broadcasts, and live access tokens are process-local. Use HTTPS and allow Socket.IO polling and WebSockets. Any additional reverse proxy must accept binary requests slightly above 10 MiB for encryption overhead.
4. For an existing installation, take a recoverable PostgreSQL backup first. Inventory current object-backed records with `SELECT count(*) FROM chatcode_messages WHERE object_key IS NOT NULL;`. Keep the existing private bucket and its configuration if it has historical objects or pending deletions. Confirm that the database role can alter its cleanup table. Startup adds two nullable columns to that table. There is no message backfill or media copy.
5. Keep the R2 bucket `chatcode-media` private, storage class Standard, with public development URLs and public custom domains disabled. Give the service a bucket-scoped Object Read & Write credential. Keep the five R2 settings below in the web service environment. Set the byte budget if you want a different ceiling.
6. For a controlled release, turn Auto-Deploy off before pushing the reviewed commit to the linked GitHub branch. Use **Manual Deploy → Deploy a specific commit** in Render. Wait for the service to pass `/ping`. The health check confirms application startup and database initialization. The first media smoke test exercises the bucket. [Render deploy options](https://render.com/docs/deploys)
7. In a new test room, upload an image, open and zoom it in a second browser, and compare the downloaded original. Verify that an older room image still opens. Restart the service and rejoin the test room. Verify the history, preview and original again. Check that a different room cannot fetch the file and confirm a new `chatcode/r2/` object in the private bucket dashboard.
8. If checks fail, set `CHATCODE_STORAGE_BUDGET_BYTES=0` and redeploy this R2-aware revision to pause new attachments while retaining text and media reads. Repair access and restore the previous budget. After R2 objects exist, rolling back to an R2-unaware revision can break reads and cleanup. Keep the database, both bucket configurations and objects together when restoring.

Production startup requires PostgreSQL. Render's ephemeral service filesystem is unsuitable for saved history. The service needs no Render disk when using the database URL. The former version kept traffic only in memory, so historical messages from that version cannot be recovered. [Render Postgres connection guide](https://render.com/docs/postgresql-creating-connecting)

## Private attachment storage

The server uses the existing AWS SDK for JavaScript v3. With the following settings, it writes all newly published attachments to private R2 using region `auto`. No new package or browser credential is needed. [Cloudflare SDK configuration](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)

| Render setting | Value or purpose |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account that owns the bucket. |
| `R2_ENDPOINT` | HTTPS S3 API account endpoint from R2, without a bucket name or object path. |
| `R2_BUCKET_NAME` | `chatcode-media` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Bucket-scoped service credentials, held in Render secret settings. |
| `CHATCODE_STORAGE_BUDGET_BYTES` | Optional nonnegative integer. Default 134217728 (128 MiB). Zero pauses new uploads. |

PostgreSQL retains the room hash, message ID, timestamp and attachment metadata (file ID, MIME type, name, dimensions for images, and original size) in the existing message row and JSON payload. The object key references AES-GCM encrypted bytes served by the existing room-authorized download endpoint. The bucket receives opaque keys and binary content type. Staging a file in the composer does not publish it. The durable write happens when sending the message.

R2 keys start with `chatcode/r2/`. Historical rows with a null key read their original PostgreSQL bytes. Older `chatcode/<uuid>` keys continue using the legacy settings below even when R2 is active. Keep the bucket/account behind each backend stable. Missing original bytes require recovery from a matching backup. For local development without a bucket, explicitly select `CHATCODE_MEDIA_BACKEND=database`. A partial R2 configuration fails startup and an unavailable R2 service produces a retryable error.

| Variable | Purpose |
|---|---|
| `S3_BUCKET` | Private legacy bucket. Also receives new writes when configured without R2. |
| `AWS_REGION` | Bucket region, or the region value required by your provider. Defaults to us-east-1. |
| `S3_ENDPOINT` | Optional S3-compatible endpoint. Use HTTPS on Render. The client uses path-style addressing with a custom endpoint. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Provider credentials supplied through Render secret settings or the AWS SDK credential chain. Temporary credentials may also require `AWS_SESSION_TOKEN`. |

Limit the service identity to reading, writing, and deleting objects under the bucket's `chatcode/` prefix. Browsers receive opaque file IDs and fetch through authenticated, room-scoped HTTP requests. Bucket URLs and credentials stay on the server. Keep the same bucket and access settings as long as stored history references that bucket. Enabling a bucket leaves previous database-backed attachments readable. When restoring backups, restore the matching bucket contents too.

Browsers use AES-GCM with a key derived from the room code. The server receives that code and decrypts uploads briefly to validate their contents. Usernames, timestamps, attachment names and validated file types are metadata. Format checks do not scan for malware. Keep authorization headers, database URLs, room codes and file contents out of logs.

## Files and retention

- New images support JPEG, PNG, WebP and single-frame GIF, up to 8 MB (8,000,000 original bytes) and 32 million pixels. PDF, ZIP, DOCX, XLSX, PPTX, TXT, Markdown and CSV retain the 10 MiB limit. Existing larger images remain downloadable.
- Four concurrent uploads per process, one per session, with up to 12 accepted attempts per minute per session and 120 per minute across the process. An encrypted staging buffer expires after two minutes. Retained attachments, in-progress object reservations, and known-size pending deletions count toward the 40 MiB room cap and configurable service budget, including 28 bytes of encryption overhead per file. Concurrent publishers reserve capacity in PostgreSQL before object writes. Retrying a staged file reuses its key.
- Run `psql "$DATABASE_URL" -f storage-usage.sql` from an authorized environment for read-only aggregate diagnostics. Add retained encrypted bytes and known reserved bytes to compare against the budget. Older cleanup entries may have unknown sizes. Compare against the R2 dashboard for actual bucket usage and operations. The application budget cannot guarantee zero billing overages, or account for unrelated objects, request charges or backups.
- Saving a message, associating its file and pruning the oldest messages occur in one database transaction. Reading a room does not extend its history beyond the latest 100 messages. Idle rooms retain their history. Monitor total database usage as the room count grows.
- Clearing a conversation explicitly deletes shared history for everyone. Leaving, reconnecting and restarting do not clear it. Pruning and clearing immediately revoke server download access. Database bytes are deleted in the transaction. For bucket-backed files, a durable deletion queue retries cleanup after outages or restarts. Failed or interrupted publications reserve cleanup records before writing objects. A downloaded copy remains with its recipient.
- If the bucket has versioning, configure noncurrent-version retention separately. Avoid lifecycle rules that delete current objects while retained messages still reference them.
