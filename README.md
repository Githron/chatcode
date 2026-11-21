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
2. In the web service's **Environment** settings, set **DATABASE_URL** to the database's internal connection URL. Keep the URL in Render's secret settings. The PostgreSQL role needs permission to create and use the `chatcode_*` tables, indexes and sequence, and to alter the existing cleanup table. Tables are initialized before the app starts listening.
3. Use Node.js 22 or later, build with `npm ci`, start with `npm start`, and keep the health check at `/ping`. Deploy one web-service instance. Socket.IO presence, ordered live broadcasts, and live access tokens are process-local. Use HTTPS and allow Socket.IO polling and WebSockets. Any additional reverse proxy must accept binary requests slightly above 10 MiB for encryption overhead.
4. For an existing installation, take a recoverable PostgreSQL backup first. Inventory current object-backed records with `SELECT count(*) FROM chatcode_messages WHERE object_key IS NOT NULL;`. Keep the existing private bucket and its configuration if it has historical objects or pending deletions. Startup adds any missing cleanup columns for byte count, room and music reservation ID. Existing messages and media stay in place.
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

### Diagnosing a failed image send

A successful `POST /api/files` stages the validated image in memory. On `send_message`, the server checks the receipt, reserves capacity in PostgreSQL, puts the encrypted bytes in the bucket, then saves the message and consumes the reservation in one database transaction. The room receives the message after that transaction commits.

Filter Render logs for `storage_failure` at the time of the failed send. The `operation` identifies the failing step. For example, `postgres.insert_reservation` precedes the bucket write, `r2.PutObject` is the bucket write, and `postgres.insert_message` follows it. PostgreSQL errors include SQLSTATE when available (for example, `42501` for insufficient privilege). R2 errors include a recognized error code and HTTP status when available. An unrecognized provider error is recorded as `unknown`. Retries reuse the reservation while the upload is still staged.

## Files and retention

- New images support JPEG, PNG, WebP and single-frame GIF, up to 8 MB (8,000,000 original bytes) and 32 million pixels. PDF, ZIP, DOCX, XLSX, PPTX, TXT, Markdown and CSV retain the 10 MiB limit. Existing larger images remain downloadable.
- MP4 and WebM clips share the 10 MiB limit (10,485,760 bytes before encryption). The server checks container boundaries, video tracks and media data. WebM supports VP8, VP9 and AV1 tracks. Container validation does not decode every frame. Playback depends on the browser and codec. The original download remains available.
- Opening a room or reloading history shows a play button, filename and size. Pressing Play fetches the private encrypted file and decrypts it in the browser. The native player seeks within that complete local copy. There is no HTTP range streaming or transcoding. Switching clips, leaving the room, disconnecting or removing the message releases the player and its Blob URL. The script-free player frame has a separate Blob-only media policy.
- Four concurrent uploads per process, one per session, with up to 12 accepted attempts per minute per session and 120 per minute across the process. An encrypted staging buffer expires after two minutes. Retained attachments, in-progress object reservations, and known-size pending deletions count toward the 40 MiB room cap and configurable service budget, including 28 bytes of encryption overhead per file. Concurrent publishers reserve capacity in PostgreSQL before object writes. Retrying a staged file reuses its key.
- Run `psql "$DATABASE_URL" -f storage-usage.sql` from an authorized environment for read-only aggregate diagnostics. Add retained encrypted bytes and known reserved bytes to compare against the budget. Older cleanup entries may have unknown sizes. Compare against the R2 dashboard for actual bucket usage and operations. The application budget cannot guarantee zero billing overages, or account for unrelated objects, request charges or backups.
- Saving a message, associating its file and pruning the oldest messages occur in one database transaction. Reading a room does not extend its history beyond the latest 100 messages. Idle rooms retain their history. Monitor total database usage as the room count grows.
- Clearing a conversation explicitly deletes shared history for everyone. Leaving, reconnecting and restarting do not clear it. Pruning and clearing immediately revoke server download access. Database bytes are deleted in the transaction. For bucket-backed files, a durable deletion queue retries cleanup after outages or restarts. Failed or interrupted publications reserve cleanup records before writing objects. A downloaded copy remains with its recipient.
- If the bucket has versioning, configure noncurrent-version retention separately. Avoid lifecycle rules that delete current objects while retained messages still reference them.

### Private room music storage and transfer

The server creates the music schema on startup. Music transfer is disabled by default. For local testing with private R2 settings, `CHATCODE_MUSIC_UPLOADS=1` registers the two HTTP routes below. Queue commands have an independent switch.

| Endpoint | Contract |
|---|---|
| `POST /api/music/tracks` | Use the live room bearer token, `Content-Type: application/octet-stream`, a known content length and a percent-encoded MP3 filename in `X-File-Name`. Send the binary envelope from `seal(roomKey, originalBytes)` in `public/transfer.js`. The response contains `id`, `name`, `size` (original bytes), `type` and `durationMs`. A successful write returns 201. A previously published upload returns 200. |
| `GET /api/music/tracks/:id` | Use a current room bearer token. The response is the full encrypted envelope with `Cache-Control: no-store`. Decrypt it with `unseal(roomKey, bytes)`. A missing session returns 401. A track missing from that room returns 404. |

MP3s may contain up to 10 MiB of original bytes. The server authenticates the AES-GCM envelope and checks ID3 boundaries, MPEG-1/2/2.5 Layer III frame lengths, audio side information and bit-reservoir bounds. It computes duration from the frames, checks Xing/Info counts when present and accounts for recognized encoder padding. Both constant and variable bitrates are supported. This structural check does not decode PCM. Free-format bitrate, compressed ID3v2.2 tags, older tag-wide unsynchronisation and trailing APE tags are outside this release.

Retry the same filename and original bytes after reconnecting, including after a 503. Each room deduplicates by a keyed digest of those inputs, including when the browser encrypts again with a fresh IV. The server resumes the same reservation and uses a create-only R2 PUT. A committed object therefore keeps its original ciphertext. Uploads share chat's rate and concurrency limits. Music downloads permit one in flight per session and four per service instance.

Tracks belong to the room independently of chat messages. Queue entries have stable IDs and can refer to the same track more than once. One playback row per room owns the current entry, position in milliseconds, playing flag, database-time anchor and revision. Edits use the revision string from a snapshot. A stale edit must obtain a fresh snapshot before retrying. Removing the selected entry or its track clears the selection and pauses playback. Reopening storage restores the recorded state.

The service reserves capacity before the private R2 PUT and publishes metadata after confirming the object exists. The object key stays server-side. Abandoned reservations expire after one hour. Publication transfers their charge to the track atomically. Deletion transfers the charge to the cleanup queue until R2 confirms removal. Tracks use the existing 40 MiB room and configurable service budgets, including 28 encryption bytes per track. Sum the attachment, music and pending-byte results in `storage-usage.sql`.

The music migrations add track, queue-entry, playback and command-receipt tables, their indexes, and a nullable indexed music reservation ID on the cleanup table. Existing message rows and R2 keys require no backfill. Before a future release, rehearse on a restored backup and allow for a short schema lock at startup. For rollback, retain the additive schema and keep music writers disabled. An older binary omits published music from its quota calculation, so retain the updated accounting or suspend new media uploads if any tracks exist. Dropping music tables would discard object ownership and playlist state.

### Shared room queue

`CHATCODE_MUSIC_QUEUE=1` registers two Socket.IO events for joined room members. The default is off. The queue can manage previously uploaded tracks while uploads are disabled. Uploading adds a track to the room library. A separate command adds it to the queue.

- After a successful join or reconnect, request `music_queue_get` with `{room}`. The acknowledgement contains `ok` and `snapshot`. The snapshot includes the revision as a decimal string, current selection, playback state, the complete ordered queue, and up to 100 room tracks. Pass `afterTrackId: snapshot.nextTrackCursor` for the next library page. A null cursor ends the list. Restart pagination if the revision changes between pages.
- Send `music_queue_command` with `room`, a fresh UUID in `commandId`, the snapshot's `expectedRevision`, and one action from the table below. The server uses the joined socket's room for every query. Each accepted edit increments the room revision once.
- Each committed edit emits `music_queue_changed` with its `revision` to members of that room. Subscribe before fetching the snapshot, refresh when notified of a newer revision and discard older snapshots. Compare revisions as integers (for example, with `BigInt`).

| Action | Required argument | Effect |
|---|---|---|
| `add` | `trackId` | Append a new entry for a room track. Multiple entries may reference the same track. The queue holds up to 256 entries. |
| `remove` | `entryId` | Remove one occurrence. Removing the selected entry clears selection, position and time anchor, and pauses playback. The track remains in the library. |
| `reorder` | `entryIds` | Supply every current entry ID exactly once in its new order. Entry identities and selection survive reordering. |
| `select` | `entryId` | Select the entry at position zero, paused. |

Success returns `{ok, replayed, appliedRevision, snapshot}`. If the acknowledgement is lost, resend the **identical command**, including its original revision, after rejoining. A durable receipt recovers the originally applied revision along with a fresh snapshot. A stale edit returns `ok: false`, `code: "stale_revision"` and the current snapshot. Reconcile the intended change before sending a new command ID. Changing the contents of an already applied command ID returns `command_id_reused`. Only successful edits consume IDs. Receipts are room-scoped and retained independently of chat history, so their database usage grows with accepted edits.

### Manually releasing and checking video

Use the existing single-instance service, PostgreSQL connection and private bucket. The video release requires no new packages, environment variables or schema migration. Keep Auto-Deploy off. When ready to release, use **Manual Deploy → Deploy a specific commit** for the reviewed SHA, then check `/ping`.

1. In a fresh test room, send a small MP4 and WebM. Join on a phone or second browser. Confirm the filenames, sizes and sender labels.
2. Reload and rejoin. In the Network panel, confirm there are no video attachment GET requests until someone presses Play or Download. Play each clip, pause, seek, try fullscreen and download the original. Some mobile browsers expose volume through hardware controls.
3. Rejoin after a service restart and play the retained clips. Confirm a user in a different room cannot retrieve their file IDs. Clear only the disposable test room and verify those files stop resolving.
