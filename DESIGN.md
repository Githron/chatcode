---
name: "ChatCode"
description: "A charcoal room-based messenger with red actions and a bracketed wordmark."
colors:
  canvas: "#181818"
  canvas-elev: "#303030"
  ink: "#ffffff"
  body: "#969696"
  muted: "#666666"
  muted-soft: "#8f8f8f"
  rosso: "#da291c"
  rosso-active: "#b01e0a"
  hairline: "#303030"
  yellow: "#fff200"
typography:
  display:
    fontFamily: "Inter, -apple-system, system-ui, sans-serif"
    fontSize: "56px"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-1.12px"
  title:
    fontFamily: "Inter, -apple-system, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 500
    letterSpacing: "-0.36px"
  room-code:
    fontFamily: "Inter, -apple-system, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "Inter, -apple-system, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  action:
    fontFamily: "Inter, -apple-system, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "1.4px"
  label:
    fontFamily: "Inter, -apple-system, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "1.1px"
  author:
    fontFamily: "Inter, -apple-system, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.65px"
  time:
    fontFamily: "Inter, -apple-system, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 400
rounded:
  square: "0px"
  field: "4px"
  pill: "9999px"
  dot: "50%"
spacing:
  xxxs: "4px"
  xxs: "8px"
  xs: "16px"
  sm: "24px"
  md: "32px"
  lg: "48px"
  xl: "64px"
  xxl: "96px"
components:
  button-connect:
    backgroundColor: "{colors.rosso}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    typography: "{typography.action}"
    height: "48px"
    padding: "14px 32px"
    width: "100%"
  button-send:
    backgroundColor: "{colors.rosso}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    typography: "{typography.action}"
    height: "48px"
    padding: "14px 32px"
  button-primary-hover:
    backgroundColor: "{colors.rosso-active}"
  button-clear:
    textColor: "{colors.body}"
    rounded: "{rounded.square}"
    typography: "{typography.label}"
    padding: "6px 12px"
  button-leave:
    textColor: "{colors.body}"
    rounded: "{rounded.square}"
    padding: "10px"
  button-image:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    rounded: "{rounded.square}"
    size: "48px"
  text-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "14px 16px"
    height: "48px"
  room-info:
    backgroundColor: "{colors.canvas-elev}"
    rounded: "{rounded.square}"
    padding: "{spacing.xs}"
  member-tag:
    backgroundColor: "{colors.rosso}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  message-self:
    backgroundColor: "{colors.rosso}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    typography: "{typography.body}"
    padding: "10px 14px"
  message-other:
    backgroundColor: "{colors.canvas-elev}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    typography: "{typography.body}"
    padding: "10px 14px"
---

# ChatCode design system

## Overview

The join screen centers a bracketed wordmark and two fields against a charcoal backdrop. In the room, the same wordmark moves into the sidebar and the conversation gets the available space. Red connects the room code, the sender’s own messages, and the action that sends the next one.

**Key characteristics**

- A white CHAT and red CODE sit between muted brackets.
- Square message bubbles distinguish authors by both position and fill.
- Compact uppercase labels sit beside mixed-case conversation text.

## Colors

Rosso Corsa marks Connect, Send, outgoing messages, the current user, presence indicators, and the rule beside a quoted reply. Hovering or pressing a primary button darkens the red. The same hue carries errors and connection updates, where the text explains the state.

White carries conversation text. Body gray carries instructions, incoming authors, and secondary actions. Muted gray recedes further for timestamps, placeholders, and brackets. Field labels use the lighter muted gray. The raised charcoal fill and the hairline share a value but serve different roles. Yellow is the global keyboard-focus accent. Only the join backdrop has a gray-to-charcoal gradient with a thin red line at the bottom.

## Typography

Inter runs throughout, with system sans-serif fallbacks. The join wordmark is medium-weight with tight tracking. It steps from 56px to 36px at widths of 1024px and below, then to 32px at 640px and below. The sidebar wordmark uses 18px. Body copy and messages use 14px type with a 1.5 line height. Short uppercase labels use tracking to separate them from the conversation. Times use the smallest text (10px).

## Layout

The join content is left aligned within a centered column capped at 520px. The form is capped at 480px, with 16px between groups and 8px between each label and field.

On desktop, a 240px sidebar holds the room code, member list, and Leave Room action. The chat column has a 64px header, independently scrolling history with 24px by 32px padding, and a bottom composer. Bubbles occupy up to 72% of the history width. Typing status and the reply preview appear directly above the input bar.

At 640px and below, the sidebar becomes a menu-controlled drawer. The header shrinks to 50px, history padding becomes 16px, and the bubble maximum grows to 88%. The bottom bar uses 8px padding and keeps its controls 48px high.

## Elevation & Depth

Subtle changes in charcoal and 1px separators distinguish the header, member list, incoming messages, and composer. The join content sits directly on the backdrop. The field focus treatment adds a 2px translucent red ring. An expanded image occupies a fixed near-black overlay with the image bounded to 92% of the viewport in each direction.

## Shapes

Primary and secondary buttons, message bubbles, room panels, and image thumbnails have square corners. Text fields and the reply-cancel control use 4px corners. The header username and YOU badge use pill shapes. Presence and typing indicators use circles.

## Components

| Component | Appearance and behavior |
|---|---|
| Join form | Two labeled fields precede a full-width Connect button. Focusing a field turns its border red. While joining, the button dims and its label reads `SECURING...`. |
| Room sidebar | A red code and online count lead into a list of members. Each row carries a dot and a name. The current user has a red name and a YOU badge. Leave Room sits at the bottom. |
| Header actions | The room code takes the flexible space. Clear uses a compact outlined button, and the username sits in an outlined pill. The menu icon appears at the phone breakpoint. |
| Messages | The author and timestamp sit above the bubble. Outgoing messages align right with the author nearest the right edge. Incoming messages align left. System notices are centered. |
| Composer | An outlined image button, flexible text field, and solid Send button share one row. Hovering the image button highlights its icon and border. Typing dots animate above the row. |
| Replies and images | Selecting message text opens a preview above the composer. The quoted content in a sent reply has a 3px red left edge. Image thumbnails open an overlay on selection. |

New messages rise 8px and fade in over 200ms. The reply preview rises 6px over 150ms. The reduced-motion rule shortens CSS animation and transition durations to 0.01ms.

## Do's and Don'ts

**Do**

- Pair outgoing red with right alignment and incoming charcoal with left alignment.
- Keep author names and timestamps outside the message bubble.
- Use the sidebar for room membership and keep message entry in the bottom bar.

**Don't**

- Avoid pill-shaped message bubbles and primary buttons.
- Avoid decorative shadows on panels or messages.
- Reserve yellow for keyboard focus.
