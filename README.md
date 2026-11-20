# ChatCode

ChatCode is an account-free browser messenger. Anyone with the same room code can join, read the latest 100 messages, reply and share files. Names are self-selected. Use a hard-to-guess code for private conversations.

## Local development

Use Node.js 22 or later. Run the following from the project directory.

```sh
npm ci
npm test
npm start
```

Open http://localhost:3000. Express serves the browser modules directly from `public/`. Development uses an on-disk embedded PostgreSQL database (PGlite) in the gitignored `.chatcode-data/` directory unless `DATABASE_URL` or `PGHOST` points to an existing PostgreSQL server. Set `CHATCODE_DATA_DIR` to choose another private directory outside the web root. Run one server per data directory. Tests create their own temporary database. Set `CHATCODE_TEST_DATABASE_URL` to an isolated PostgreSQL test database to exercise the production driver.

## Deploy on Render

1. Use an existing durable PostgreSQL database, or create a Render Postgres instance in the same region as the web service. Select a plan with the retention and backup period you need.
2. In the web service's **Environment** settings, set **DATABASE_URL** to the database's internal connection URL. Keep the URL in Render's secret settings. The PostgreSQL role needs permission to create and use the three `chatcode_*` tables and their indexes and sequence. Tables are initialized before the app starts listening.
3. Use Node.js 22 or later, build with `npm ci`, start with `npm start`, and keep the health check at `/ping`. Deploy one web-service instance. Socket.IO presence, ordered live broadcasts, and live access tokens are process-local. Use HTTPS and allow Socket.IO polling and WebSockets. Any additional reverse proxy must accept binary requests slightly above 10 MiB for encryption overhead.
4. For a smoke test, send a message and an image in a new room, leave, redeploy the service, then join from another browser. Verify that the image renders and the original downloads.

Production startup requires PostgreSQL. Render's ephemeral service filesystem is unsuitable for saved history. The service needs no Render disk when using the database URL. The former version kept traffic only in memory, so historical messages from that version cannot be recovered. [Render Postgres connection guide](https://render.com/docs/postgresql-creating-connecting)

## Private attachment storage

The database stores encrypted attachment bytes by default. A bucket is optional. To use object storage for new files, configure a **private** S3-compatible bucket.

| Variable | Purpose |
|---|---|
| `S3_BUCKET` | Bucket for the service's encrypted attachments. Omit for database-backed files. |
| `AWS_REGION` | Bucket region, or the region value required by your provider. Defaults to us-east-1. |
| `S3_ENDPOINT` | Optional S3-compatible endpoint. Use HTTPS on Render. The client uses path-style addressing with a custom endpoint. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Provider credentials supplied through Render secret settings or the AWS SDK credential chain. Temporary credentials may also require `AWS_SESSION_TOKEN`. |

Limit the service identity to reading, writing, and deleting objects under the bucket's `chatcode/` prefix. Browsers receive opaque file IDs and fetch through authenticated, room-scoped HTTP requests. Bucket URLs and credentials stay on the server. Keep the same bucket and access settings as long as stored history references that bucket. Enabling a bucket leaves previous database-backed attachments readable. When restoring backups, restore the matching bucket contents too.

Browsers use AES-GCM with a key derived from the room code. The server receives that code and decrypts uploads briefly to validate their contents. Usernames, timestamps, attachment names and validated file types are metadata. Format checks do not scan for malware. Keep authorization headers, database URLs, room codes and file contents out of logs.

## Files and retention

- Up to 10 MiB per file. Supported formats are JPEG, PNG, WebP, single-frame GIF, PDF, ZIP, DOCX, XLSX, PPTX, TXT, Markdown, and CSV. Image previews come from validated raster files; archives and documents are download-only.
- Four concurrent uploads per process, one per session. An encrypted staging buffer expires after two minutes if the message is never committed. Published files persist with the message. The logical attachment limits are 40 MiB per room and 128 MiB across the service. Allow additional storage for indexes, write-ahead logs, backups and objects awaiting deletion.
- Saving a message, associating its file and pruning the oldest messages occur in one database transaction. Reading a room does not extend its history beyond the latest 100 messages. Idle rooms retain their history. Monitor total database usage as the room count grows.
- Clearing a conversation explicitly deletes shared history for everyone. Leaving, reconnecting and restarting do not clear it. Pruning and clearing immediately revoke server download access. Database bytes are deleted in the transaction. For bucket-backed files, a durable deletion queue retries cleanup after outages or restarts. Failed or interrupted publications reserve cleanup records before writing objects. A downloaded copy remains with its recipient.
- If the bucket has versioning, configure noncurrent-version retention separately. Avoid lifecycle rules that delete current objects while retained messages still reference them.
