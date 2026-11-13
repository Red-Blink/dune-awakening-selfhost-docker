# Console chat history research

[Issue #295](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/295)
proposes searchable chat history with separate access to whispers. It is a
feature research ticket, not a report that existing Console chat is broken.

## Evidence and remaining contracts

The contributor observed the following on game build `2181988` with RabbitMQ
`3.13.7`. These are reported observations, not independent verification of every
native-client channel. Existing Console map/whisper publishing in
`console/api/src/rmq.js` corroborates those two envelope formats.

| Channel | Reported forwarding exchange | Before implementation |
| --- | --- | --- |
| Map | `chat.map` | Verify ordinary and instanced-map delivery and filtering. |
| Guild | `chat.guild.<id>` | Verify membership isolation and guild changes. |
| Proximity | `chat.proximity` | Verify range behavior; discard origin coordinates. |
| Whispers | `chat.whispers` | Verify offline recipients and enforce separate access. |
| Faction | Unverified | Capture a controlled client message and channel metadata. |
| Party | Unverified | Capture a controlled client message and channel metadata. |

The proposed tap is on `chat.intercept`, before TextRouter forwarding. A copy
there is evidence of a published message, not proof that recipients saw it.
Filtering may alter or drop it. A history viewer must distinguish those meanings
and must not claim delivery based only on interception.

## Next test

Use consenting test accounts in the local test environment. For each channel,
send a distinctive test message and record the game build, channel name,
`redirect_exchange`, routing-key **shape**, `m_ChannelType`, envelope field names,
and whether the recipient saw the same content. Include offline whispers,
instanced maps, filtered text, item links, localization, Unicode and multiline
input. Replace identities and routing-key identifiers consistently; remove
coordinates and real message text before sharing results.

Use a separate temporary queue and binding; never consume or purge TextRouter's
`queue.intercept`. Bound both message count and bytes, set message TTL and queue
expiry, and explicitly delete the queue after testing. A tap copies all channels,
including private conversations, while it exists; the 24-hour example in the
issue is not a suitable default for a deployed collector.

## Implementation gates

1. An explicitly enabled collector reuses the existing RabbitMQ transport and
   connection settings. It owns only its queue/binding, reconnects safely, and
   stays off by default. Test broker recreation and game-update recovery before
   enabling persistence. Backlog count, bytes and age must remain bounded.
2. The parser handles verified envelopes and rejects unknown or malformed data
   without persisting raw fallback payloads. Drop origin coordinates. Store
   message text as plain text; rich text must never become executable HTML.
3. Extend the existing IAM action catalog for history access and a separate
   whisper action. Enforce both in every backend search, live stream, count and
   export path before returning data. UI hiding alone is insufficient. Keep
   private conversations out of ordinary API/request logs and diagnostics.
4. Add bounded retention and deletion through the existing storage/settings
   model. Validate message volume before choosing defaults; do not retain all
   intercepted data indefinitely or treat it as part of general diagnostics.
5. Add the viewer through existing Console tabs, tables, filters and pagination.
   Test access denial, filtering, reconnects, duplicates, malformed messages,
   retention and mobile layout. Unverified channels remain unavailable.

No collector, permanent interception, retention setting or new UI is enabled by
this research document. The immediate dependency is the controlled native-client
channel test above; broker inspection alone cannot supply those observations.
