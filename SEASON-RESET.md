# NEXUS season reset

Run /season-reset in the configured NEXUS guild to preview all deletable channels/categories, editable unmanaged roles, and kickable human members. Run it again with the displayed confirm code within two minutes to execute the saved scope. No manual target selection is required.

Access: guild owner or SEASON_RESET_ROLE_IDS (comma-separated role IDs); always includes role 1560384331858452560. Send Messages permission alone does not grant access.

Requires Guild Members intent, Kick Members, Manage Channels, Manage Roles and a sufficiently high bot role. Discord protects the guild owner, @everyone, managed roles, and roles/members above the bot. The requesting member and bots remain. Roles are deleted after kicks and channel deletion. Errors are reported rather than bypassed.

The attached JSON describes channels, overwrites, roles and member role IDs. It does not contain message history or restore kicked members. Website data remains; approved scope and results are added to its audit log. A host restart cancels pending confirmations; an interrupted reset is not resumed automatically.

Deleting channels also invalidates existing channel IDs used for applications and other bot features. Configure replacement channel/category/role IDs before reopening applications.

Validated locally with syntax checking and mocked authorization, protected-member, role exclusion and deletion-order checks. No live Discord reset was executed.


## Plain message trigger
Enable Message Content Intent in Discord Developer Portal > Bot > Privileged Gateway Intents.
Then set SEASON_RESET_TEXT_ENABLED=true in Railway and redeploy. This opt-in prevents an unapproved privileged intent from disconnecting the existing bot.

An authorized member sends exactly `season-reset` in the configured guild. The bot replies with the preview and a code. Send `season-reset CODE` within two minutes in the same channel from the same account. Bot and webhook messages are ignored. The existing slash command remains available. Text previews are visible to members who can read the channel; confirmation is bound to the requesting account and channel.

Validation includes mocked text previews with no mutations, explicit role access, invalid codes, cross-channel rejection, and one-time confirmation execution. No live reset was performed.
