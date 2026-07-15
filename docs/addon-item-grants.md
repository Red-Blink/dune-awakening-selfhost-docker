# Permissioned Addon Item Grants

UI addons can request the `admin:grant-items` permission to deliver an item through the trusted Dune admin implementation. The permission does not provide shell, Docker socket, repository, or environment-file access.

The addon manifest must declare the permission:

```json
{
  "permissions": ["admin:grant-items"]
}
```

After the administrator approves the permission and enables the addon, send this bridge request:

```js
const result = await bridge("admin.items.grant", {
  requestId: "reward:12345",
  playerId: "PLAYER_FLS_ID",
  itemId: "WaterBottle_1",
  quantity: 2,
  quality: 0
});
```

`requestId` is required and must uniquely identify the reward delivery. Retrying the same request with identical grant details returns success with `duplicate: true` without granting the item again. Reusing it with different details is rejected.

Limits and validation:

- One player per request; wildcard grants are rejected.
- Quantity must be an integer from 1 through 1000.
- Quality must be an integer from 0 through 5.
- Player IDs, item IDs, and request IDs use strict character allowlists.
- The console mutation and addon bridge rate limits apply.
- Successful grants are audited with the addon ID and grant details.
- Successful request receipts are stored under `runtime/addons/grant-receipts` for retry protection.

This operation performs delivery only. Scheduling, eligibility, and reward queue state remain the addon's responsibility.
