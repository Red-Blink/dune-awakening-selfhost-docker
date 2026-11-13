# Console chat history

[Issue #295](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/295)
tracks the Console's opt-in Map, Guild and Proximity history. **Private whispers
are excluded entirely:** there is no collection option, history endpoint or IAM
permission for them. Faction and Party are not supported yet.

## Using the viewer

An owner can open **Chat → Collection**, enable collection, choose retention
from 1 to 30 days and save. Collection starts disabled on a new installation.
Existing enablement and retention survive Console rebuilds. Disabling collection
stops recording but leaves existing history subject to its retention period.

Use Search, Channel and Map / Guild to filter messages. Pagination uses the same
layout as Players: a showing range, 25/50/100/200 rows, First, Previous, page
indicator, Next and Last. The newest page refreshes every five seconds while
visible; older pages stay still for reading. Refresh works on any page.

The page shows server capture time, not guaranteed client-send or delivery time.
Publisher-supplied display names are shown alongside the broker-authenticated
sender identifier; they are not proof of character identity. Message text and
names remain inert, untranslated text.

For a local capture test, enable collection and send a message from a game
client. Console broadcasts and messages sent directly to player queues or
`chat.map` bypass this recorder's source exchange.

## Privacy and bounded storage

A private internal headers exchange filters `chat.intercept` inside RabbitMQ
**before** delivery to the recorder's queue. Its exact header matches allow only
`chat.map`, `chat.proximity` and known `chat.guild.<id>` forwarding destinations.
There is no direct unfiltered topic binding to the recorder queue. Whisper
messages are not delivered to the recorder. The parser also rejects their channel.

The recorder never consumes TextRouter's queue. Its own transient queue is capped
at 500 messages and 2 MiB, with a 60-second message TTL and idle expiry. Its filter
exchange auto-deletes when its queue bindings disappear. Guild routing changes
are reconciled automatically; reconfiguration can discard pending public copies.

History is stored in `runtime/generated/chat-history.json` with owner-only file
permissions. It keeps at most **5,000 messages or 10 MiB**, and entries expire after
the configured retention period. Raw envelopes, coordinates, recipient fields,
unknown channels and unverified localized-only payloads are not stored. Loading
an older local preview removes its whisper setting and any whisper rows while
preserving collection enablement and retention. Corrupt or oversized existing
storage stops recording without overwriting that file.

**Clear History** deletes all current history after confirmation. It cannot erase
copies from older system backups. This is best-effort published-message history:
earlier messages cannot be recovered, and outages, routing changes or queue
overflow can leave gaps. Capture does not establish that a recipient saw a message.

## Permissions

| Action | Access |
| --- | --- |
| `chat:read` | History, filters and counts. Ordinary admins by default. |
| `chat:configure` | Collection settings and history deletion. Owner by default. |

Existing custom policies remain authoritative. Every API request is authorized
in the backend. This version exposes no live stream or export endpoint.

The collector reuses the existing management connection and credentials, including
the bounded Director-log fallback when credentials scroll out of the cached tail.
An installation forcing `DUNE_RMQ_TRANSPORT=exec` cannot use this HTTP collector.

## Remaining native-client validation

The contributor observed Map, Guild and Proximity envelopes on game build
`2181988` with RabbitMQ `3.13.7`. Existing Console map publishing corroborates
the map envelope. Synthetic tests prove the collection and privacy mechanics;
they do not replace consenting native-client tests.

1. Verify each supported channel, guild membership changes and instanced maps.
2. Compare intercepted messages with recipient-visible filtering, Unicode,
   multiline, item links and localized content before expanding the parser.
3. Verify a full broker recreation and game update, including credential rotation
   and the expected gaps during downtime. Queue recreation covers only part of it.
4. Measure busy-server volume against the explicit bounds.
5. Establish Faction and Party contracts before implementing those channels.

Never share real chat, identities or coordinates in public diagnostic captures.
