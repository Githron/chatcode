# ChatCode

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

ChatCode is for anyone who receives a room code and wants to join a quick, lightweight, real-time conversation. A participant can open the site on a phone or computer, choose a username, and enter the shared code without creating an account.

## Product Purpose

Help someone go from receiving a code to exchanging a first message with the people who shared it. A successful join leaves the participant able to tell which room they entered, see who is there, and start talking.

## Operating Context

Participants arrange to use the same code before meeting in ChatCode. Inside the room, they can exchange text, images, PDFs, ZIP archives, Office documents, and text files, reply to a specific message, see who is typing, and leave when the conversation is over. On entry, participants see the latest 100 messages, including shared files and reply excerpts. Any room member can explicitly confirm permanent deletion of the shared conversation.

## Privacy and Room Access

Anyone with the room code can join under a chosen username. A username identifies a participant within the conversation and carries no identity verification.

The browser encrypts message and attachment contents before sending them. It derives the encryption key from the shared room code. The server receives that code when participants join, so it has the information needed to derive the same key. The server uses that key to validate uploaded file contents, then stores the original encrypted attachment with the saved message. Connected members can download it while its message is retained. Leaving a room does not erase history.

## Product Principles

- **Simplicity.** Keep the path from a shared code to a first message short. A first-time participant should be able to join and send without a tutorial.
- **Privacy.** Ask only for what the conversation needs. Make it clear who can enter the room and who is affected by actions such as clearing chat.
- **Responsiveness.** Keep reading, composing, and replying usable on both phones and desktops. Give timely feedback when joining or sending takes time.
- **A premium, modern messaging experience.** Make everyday exchanges feel considered. Participants should be able to follow a reply, recognize who sent a message, and tell whether an action succeeded.
