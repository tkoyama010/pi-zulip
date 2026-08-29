# pi-zulip

Zulip chat integration for [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Features

| Tool | Description |
|------|-------------|
| `zulip_get_messages` | Fetch messages from a stream or topic |
| `zulip_search_messages` | Keyword search across all messages |
| `zulip_send_message` | Send messages to streams or DMs (requires confirmation) |
| `zulip_edit_message` | Edit your own messages (content + topic) |
| `zulip_delete_message` | Delete your own messages |
| `zulip_add_reaction` | Add emoji reactions |
| `zulip_remove_reaction` | Remove emoji reactions |
| `zulip_get_streams` | List subscribed streams |
| `zulip_get_topics` | List topics in a stream |
| `zulip_create_draft` | Save a message draft for later |
| `zulip_get_drafts` | List saved drafts |
| `zulip_delete_draft` | Delete a draft |

Commands:
- `/zulip` — Check connection status
- `/zulip-setup` — Interactively configure credentials

## Setup

### Environment variables

```bash
export ZULIP_SERVER="https://your-org.zulipchat.com"
export ZULIP_EMAIL="your@email.com"
export ZULIP_API_KEY="your-api-key"
```

### Interactive setup

```
/zulip-setup
```

Guides you through entering server, email, and API key with immediate validation.

### Get your API key

Zulip → Settings → Account & privacy → API key

### Install

```bash
npm install -g @tkoyama010/pi-zulip
```

### Verify

```
/zulip
```

## Error handling

- **401**: Invalid credentials → run `/zulip-setup` to reconfigure
- **429**: Rate limited → automatic retry with `Retry-After` backoff
- **5xx**: Server error → exponential backoff, up to 3 retries
- **Abort**: Press Esc during a tool call to cancel in-flight requests

## Search syntax

`zulip_search_messages` supports Zulip search operators:

```
stream:general topic:review
sender:alice@example.com
has:link
has:image
python stream:backend near:12345
```

Combine operators with spaces.

## License

MIT
