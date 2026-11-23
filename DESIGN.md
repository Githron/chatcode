---
name: "ChatCode"
description: "A near-black room messenger with HUD hairlines, violet accents, and atmospheric gradients."
colors:
  canvas: "#090b12"
  canvas-elev: "#14151f"
  surface-raised: "#1b1c29"
  rail: "#0d0f17"
  ink: "#f4f1ff"
  body: "#c5c1d6"
  muted: "#9794aa"
  violet: "#a78bfa"
  violet-bright: "#b9a2ff"
  indigo: "#6b84ff"
  hairline: "#343245"
  hairline-soft: "#262436"
  focus: "#b9c6ff"
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
  panel: "14px"
  field: "9px"
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
    backgroundColor: "{colors.violet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    typography: "{typography.action}"
    height: "48px"
    padding: "14px 32px"
    width: "100%"
  button-send:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    typography: "{typography.action}"
    height: "48px"
    padding: "14px 32px"
  button-primary-hover:
    backgroundColor: "{colors.violet-bright}"
  button-clear:
    textColor: "{colors.body}"
    rounded: "{rounded.panel}"
    typography: "{typography.label}"
    padding: "6px 12px"
  button-leave:
    textColor: "{colors.body}"
    rounded: "{rounded.panel}"
    padding: "10px"
  button-image:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    rounded: "{rounded.panel}"
    size: "48px"
  text-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "14px 16px"
    height: "48px"
  room-info:
    backgroundColor: "{colors.canvas-elev}"
    rounded: "{rounded.panel}"
    padding: "{spacing.xs}"
  member-tag:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  message-self:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    typography: "{typography.body}"
    padding: "10px 14px"
  message-other:
    backgroundColor: "{colors.canvas-elev}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    typography: "{typography.body}"
    padding: "10px 14px"
---

# ChatCode design system

## Overview

The join screen pairs a layered HUD poster with two fields against a near-black backdrop. In the room, the wordmark moves into the sidebar and the conversation gets the available space. Violet connects the room code, the sender’s own messages, and the action that sends the next one.

**Key characteristics**

- A light CHAT and violet CODE sit beside a gradient mark.
- Rounded message bubbles distinguish authors by both position and fill.
- Compact uppercase labels sit beside mixed-case conversation text.
- Thin corner brackets and a faint grid supply the HUD atmosphere.

## Colors

Violet (`#a78bfa`) marks Connect, Send, the sender’s own messages, the current user, presence, and quoted replies; indigo (`#6b84ff`) shades the second stop of gradients and atmospheric glows. Hovering or pressing a primary button brightens the gradient.

`#f4f1ff` carries conversation text. Body lavender-gray carries instructions, incoming authors, and secondary actions. Muted gray recedes further for timestamps, placeholders, and brackets. Panels sit on the near-black canvas with soft hairlines rather than heavy shadows. Pale blue-violet is the global keyboard-focus accent. The join poster uses a violet-to-indigo radial glow with HUD corner brackets and a masked grid.

## Typography

Inter runs throughout, with system sans-serif fallbacks. The join wordmark is medium-weight with tight tracking. It steps from 56px to 36px at widths of 1024px and below, then to 32px at 640px and below. The sidebar wordmark uses 18px. Body copy and messages use 14px type with a 1.5 line height. Short uppercase labels use tracking to separate them from the conversation. Times use the smallest text (10px).

## Layout

The join content is left aligned within a centered column capped at 520px. The form is capped at 480px, with 16px between groups and 8px between each label and field.

On desktop, a 240px sidebar holds the room code, member list, and Leave Room action. The chat column has a 64px header, independently scrolling history with 24px by 32px padding, and a bottom composer. Bubbles occupy up to 72% of the history width. Typing status and the reply preview appear directly above the input bar.

At 640px and below, the sidebar becomes a menu-controlled drawer. The header shrinks to 50px, history padding becomes 16px, and the bubble maximum grows to 88%. The bottom bar uses 8px padding and keeps its controls 48px high.

## Elevation & Depth

Near-black surfaces and 1px hairlines distinguish the header, member list, incoming messages, and composer. Ambient violet and indigo gradients sit behind the join poster and workspace. The field focus treatment adds a soft violet ring and a low-opacity glow. An expanded image occupies a fixed near-black overlay with the image bounded to 92% of the viewport in each direction.

## Shapes

Primary buttons, message bubbles, room panels, and image thumbnails use 8–14px corners; bubbles keep a tighter corner on the sender’s side. Text fields and the reply control use 9px corners. The header username and YOU badge use pill shapes. Presence and typing indicators use circles.

## Components

| Component | Appearance and behavior |
|---|---|
| Join form | Two labeled fields precede a full-width Connect button. Focusing a field turns its border violet. While joining, the button dims and its label reads `Joining…`. |
| Room sidebar | A violet room glyph and online count lead into a list of members. Each row carries an avatar and a name. The current user has a violet avatar and a YOU badge. Leave Room sits at the bottom. |
| Header actions | The room code takes the flexible space. Clear uses a compact outlined button, and the username sits in an outlined pill. The menu icon appears at the phone breakpoint. |
| Messages | The author and timestamp sit above the bubble. Outgoing messages align right on a violet-indigo gradient; incoming messages sit on a bordered panel. System notices are centered. |
| Composer | An outlined image button, flexible text field, and gradient Send button share one row. Hovering the image button highlights its icon and border. Typing dots animate above the row. |
| Replies and images | Selecting message text opens a preview above the composer. The quoted content in a sent reply has a 2px violet left edge. Image thumbnails open an overlay on selection. |

New messages rise 4px and fade in over 170ms. The reduced-motion rule shortens CSS animation and transition durations to 0.01ms.

## Do's and Don'ts

**Do**

- Pair the outgoing gradient with right alignment and incoming panels with left alignment.
- Keep author names and timestamps outside the message bubble.
- Use the sidebar for room membership and keep message entry in the bottom bar.
- Keep HUD lines and glows at low opacity so text stays dominant.

**Don't**

- Avoid pill-shaped message bubbles and primary buttons.
- Avoid saturated neon, stacked shadows, or decorative panels that compete with messages.
- Reserve the pale focus ring for keyboard focus.
