# ChatCode

ChatCode is an account-free browser messenger. Enter the same room code on two devices to exchange messages, reply, see who is online, and share files.

## Run and test

Use Node.js 22 or 24 with npm. From the project directory run:

```sh
npm ci
npm test
npm start
```

Open http://localhost:3000. The test suite starts its own server on an ephemeral port and uses independent Socket.IO and HTTP clients. Express serves the browser modules, CSS and bundled Inter font directly from `public/`. There is no frontend compilation step.

## Attachments and privacy

- Attach one PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, TXT, Markdown, or CSV per message, up to 10 MiB. Messages may contain a caption. The sender sees upload progress, and recipients can preview images and download the original bytes.
- A live Socket.IO room membership issues an opaque bearer credential held in page memory. Uploads and downloads require that credential. Other rooms cannot retrieve the bytes. Anyone with the shared room code can join. Share the code only with intended participants.
- Browsers encrypt messages and files with AES-GCM using a key derived from the room code. The server knows the room code and temporarily decrypts file contents for format and size validation. File names and membership are visible to the server. Format checks are not malware scanning.
- Attachments reside in private process memory as ciphertext. Unpublished uploads expire after two minutes, published files after one hour. Clearing a room, its last member leaving, or restarting the server removes its files. A downloaded copy remains on the recipient’s device. Conversations have no persistent server-side history.
- Limits are 40 MiB per room, 128 MiB of stored ciphertext per process, four simultaneous uploads per process, and one per session. Leave additional RAM for active uploads and decryption. Use this version as a single-instance service.

## Deployment

Use `npm ci` as the install command and `npm start` to run the service. Configure `PORT` if required by the host. The health endpoint is `/ping`; the existing Render configuration starts the same server. Serve the public app over HTTPS for browser cryptography. A reverse proxy must forward Socket.IO polling, WebSocket upgrades, and binary requests slightly larger than 10 MiB to allow for encryption overhead.

No disk volume, object-storage bucket, or application secret is required. Serve only the Express application. Keep the repository root, environment files, and local user files outside the web root. Avoid logging authorization headers, room codes, and attachment bodies. Persistent storage or horizontally scaled deployment requires shared membership, attachment storage, and expiry handling.
