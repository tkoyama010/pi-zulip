# pi-zulip

Zulip chat integration for [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Features

- **zulip_get_messages** — Fetch messages from a stream or topic
- **zulip_send_message** — Send messages to streams or DMs
- **zulip_get_streams** — List subscribed streams
- **zulip_get_topics** — List topics in a stream
- **zulip_create_draft** — Save a message draft for later
- **zulip_get_drafts** — List saved drafts
- **zulip_delete_draft** — Delete a draft
- **/zulip** — Check connection status

## Setup

### 1. Get your Zulip API key

1. Open Zulip → Settings → Account & privacy → API key
2. Copy your API key

### 2. Set environment variables

```bash
export ZULIP_SERVER="https://your-org.zulipchat.com"
export ZULIP_EMAIL="your@email.com"
export ZULIP_API_KEY="your-api-key"
```

Or add to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.).

### 3. Install

```bash
# Global (all projects)
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-zulip ~/.pi/agent/extensions/pi-zulip

# Or point pi directly
pi -e /path/to/pi-zulip/src/index.ts
```

### 4. Verify

```
/zulip
```

## Tools

### zulip_get_messages

Fetch messages from a stream, optionally filtered by topic.

```
Parameters:
  stream       (optional) Stream name
  topic        (optional) Topic name
  num_before   (optional) Messages before anchor (default: 10)
  num_after    (optional) Messages after anchor (default: 0)
  include_anchor (optional) Include anchor message (default: false)
```

### zulip_send_message

Send a message to a stream or DM.

```
Parameters:
  type    "stream" or "private"
  to      Stream name or comma-separated emails
  topic   Topic name (required for stream)
  content Message content (Markdown)
```

### zulip_get_streams

List your subscribed streams.

```
Parameters:
  include_all  Include unsubscribed streams (default: false)
```

### zulip_get_topics

List topics in a stream.

```
Parameters:
  stream  Stream name (required)
```

### zulip_create_draft

Save a draft message for later editing and sending.

```
Parameters:
  type     "stream" or "private"
  to       Stream name or comma-separated emails
  topic    Topic name (required for stream)
  content  Draft content (Markdown)
```

### zulip_get_drafts

List all saved drafts.

### zulip_delete_draft

Delete a saved draft by ID.

```
Parameters:
  draft_id  ID of the draft to delete
```

## License

MIT
