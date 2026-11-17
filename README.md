# chatcode

ChatCode — real-time, room-based messenger inspired by IPChat.

## Run

```bash
npm install
npm start          # http://localhost:3000
```

## Stack

- **Frontend**: vanilla JS + Ferrari-inspired CSS (Inter, near-black canvas, Rosso Corsa accents, sharp corners)
- **Backend**: Node.js, Express, Socket.IO
- **Security**: room code is an identifier only (never exposes real IPs); messages are E2E-encrypted client-side with an AES-GCM key derived from the room code, so the server only ever relays ciphertext

## Features

- Join screen with username + room code
- Real-time messaging, typing indicator, reply preview, image sharing
- Member list with online count, join/leave notices
- Room isolation, rate limiting, server-side validation
- Clear chat authorized per-room
- Responsive layout with mobile sidebar toggle
