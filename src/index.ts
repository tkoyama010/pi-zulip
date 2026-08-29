import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─── Config ────────────────────────────────────────────────────────────────

type ZulipConfig = {
  server: string;
  email: string;
  apiKey: string;
};

let cachedConfig: ZulipConfig | null = null;

function getZulipConfig(): ZulipConfig {
  if (cachedConfig) return cachedConfig;

  const server = process.env.ZULIP_SERVER;
  const email = process.env.ZULIP_EMAIL;
  const apiKey = process.env.ZULIP_API_KEY;

  const missing: string[] = [];
  if (!server) missing.push("ZULIP_SERVER");
  if (!email) missing.push("ZULIP_EMAIL");
  if (!apiKey) missing.push("ZULIP_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing env vars: ${missing.join(", ")}. Run /zulip-setup to configure.`,
    );
  }

  cachedConfig = { server: server!, email: email!, apiKey: apiKey! };
  return cachedConfig!;
}

function authHeader(): string {
  const { email, apiKey } = getZulipConfig();
  return `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;
}

function zulipUrl(path: string): string {
  const { server } = getZulipConfig();
  const base = server.endsWith("/") ? server.slice(0, -1) : server;
  return `${base}/api/v1${path}`;
}

// ─── Retry-aware fetch ────────────────────────────────────────────────────

type ZulipFetchOptions = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  retries?: number;
};

const DEFAULT_RETRIES = 3;

async function zulipFetch(
  path: string,
  opts: ZulipFetchOptions = {},
  ctx?: ExtensionContext,
): Promise<unknown> {
  const { method, body, headers, retries } = opts;
  const maxRetries = retries ?? DEFAULT_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const signal = ctx?.signal;
    const response = await fetch(zulipUrl(path), {
      method,
      body,
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      signal,
    });

    if (response.ok) {
      if (response.status === 204) return null; // DELETE returns 204
      return response.json();
    }

    const errorBody = await response.text();

    // 400 — bad request (invalid params, not retryable)
    if (response.status === 400) {
      throw new Error(`Zulip API 400: ${errorBody}`);
    }

    // 401 — unauthorized (API key issue, not retryable)
    if (response.status === 401) {
      throw new Error(
        "Zulip API 401: invalid credentials. Run /zulip-setup to reconfigure.",
      );
    }

    // 403 — permission denied, not retryable
    if (response.status === 403) {
      throw new Error(`Zulip API 403: ${errorBody}`);
    }

    // 429 — rate limited (wait for Retry-After)
    if (response.status === 429) {
      const retryAfter = parseInt(
        response.headers.get("retry-after") || "60",
        10,
      );
      if (attempt < maxRetries) {
        ctx?.ui.setStatus(
          "zulip",
          `Rate limited, retrying in ${retryAfter}s (attempt ${attempt + 1}/${maxRetries})`,
        );
        await sleep(retryAfter * 1000, signal);
        continue;
      }
      throw new Error(
        `Zulip API 429: rate limited after ${maxRetries + 1} attempts.`,
      );
    }

    // 5xx — server error (retryable)
    if (response.status >= 500 && attempt < maxRetries) {
      const backoff = Math.min(1000 * 2 ** attempt, 30_000);
      await sleep(backoff, signal);
      continue;
    }

    // Everything else
    throw new Error(`Zulip API ${response.status}: ${errorBody}`);
  }

  throw new Error("Zulip API: unexpected fallthrough after retries.");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }, { once: true });
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function renderMessage(
  msg: {
    id: number;
    sender_email: string;
    sender_full_name: string;
    subject: string;
    stream_name?: string;
    display_recipient?: unknown;
    content: string;
    timestamp: number;
    reactions?: Array<{
      emoji_name: string;
      user: { full_name: string };
    }>;
  },
  includeReactions: boolean,
): string {
  const time = new Date(msg.timestamp * 1000).toISOString();
  const stream = msg.stream_name ? `[${msg.stream_name}] ` : "";
  let text = `[${time}] ${stream}${msg.sender_full_name} (${msg.subject}):\n${msg.content}`;

  if (includeReactions && msg.reactions && msg.reactions.length > 0) {
    const grouped = new Map<string, string[]>();
    for (const r of msg.reactions) {
      const list = grouped.get(r.emoji_name) ?? [];
      list.push(r.user.full_name);
      grouped.set(r.emoji_name, list);
    }
    const parts: string[] = [];
    for (const [emoji, users] of grouped) {
      parts.push(`${emoji} ${users.join(", ")}`);
    }
    text += `\n\nReactions: ${parts.join(" | ")}`;
  }

  return text;
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── zulip_get_messages ───────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_get_messages",
    label: "Zulip Get Messages",
    description: "Fetch messages from a Zulip stream, topic, or narrow",
    parameters: Type.Object({
      stream: Type.Optional(
        Type.String({ description: "Stream name to fetch messages from" }),
      ),
      topic: Type.Optional(
        Type.String({ description: "Topic name to filter by" }),
      ),
      num_before: Type.Optional(
        Type.Number({
          description: "Number of messages before the anchor",
          default: 10,
        }),
      ),
      num_after: Type.Optional(
        Type.Number({
          description: "Number of messages after the anchor",
          default: 0,
        }),
      ),
      include_reactions: Type.Optional(
        Type.Boolean({
          description: "Include message reactions in output",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const narrow: Array<{
        operator: string;
        operand: string | number;
      }> = [];

      if (params.stream) {
        narrow.push({ operator: "stream", operand: params.stream });
      }
      if (params.topic) {
        narrow.push({ operator: "topic", operand: params.topic });
      }

      const query = new URLSearchParams({
        narrow: JSON.stringify(narrow),
        anchor: "newest",
        num_before: String(params.num_before ?? 10),
        num_after: String(params.num_after ?? 0),
        apply_markdown: "true",
      });

      const data = (await zulipFetch(
        `/messages?${query}`,
        {},
        ctx,
      )) as {
        messages: Array<{
          id: number;
          sender_email: string;
          sender_full_name: string;
          subject: string;
          stream_name?: string;
          display_recipient?: unknown;
          content: string;
          timestamp: number;
          reactions: Array<{
            emoji_name: string;
            user: { full_name: string };
          }>;
        }>;
      };

      if (data.messages.length === 0) {
        return {
          content: [{ type: "text", text: "No messages found." }],
          details: { count: 0 },
        };
      }

      const showReactions = params.include_reactions ?? false;
      const lines = data.messages.map((msg) =>
        renderMessage(msg, showReactions),
      );

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.messages.length} message(s):\n\n${lines.join("\n\n---\n\n")}`,
          },
        ],
        details: { count: data.messages.length },
      };
    },
  });

  // ── zulip_send_message ───────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_send_message",
    label: "Zulip Send Message",
    description: "Send a message to a Zulip stream or direct message (requires user confirmation)",
    parameters: Type.Object({
      type: Type.Union(
        [Type.Literal("stream"), Type.Literal("private")],
        {
          description: "'stream' for stream message, 'private' for DM",
        },
      ),
      to: Type.String({
        description:
          "Stream name (for stream) or comma-separated emails (for DM)",
      }),
      topic: Type.Optional(
        Type.String({
          description: "Topic name (required for stream messages)",
        }),
      ),
      content: Type.String({
        description: "Message content (Markdown supported)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      if (params.type === "stream" && !params.topic) {
        throw new Error(
          "'topic' is required for stream messages.",
        );
      }

      const body = new URLSearchParams({
        type: params.type,
        to: params.to,
        content: params.content,
        ...(params.topic ? { topic: params.topic } : {}),
      });

      const data = (await zulipFetch(
        "/messages",
        { method: "POST", body: body.toString() },
        ctx,
      )) as { id: number };

      return {
        content: [
          { type: "text", text: `Message sent (id: ${data.id}).` },
        ],
        details: { messageId: data.id },
      };
    },
  });

  // ── zulip_edit_message ───────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_edit_message",
    label: "Zulip Edit Message",
    description: "Edit an existing Zulip message (your own only)",
    parameters: Type.Object({
      message_id: Type.Number({
        description: "ID of the message to edit",
      }),
      content: Type.Optional(
        Type.String({ description: "New message content" }),
      ),
      topic: Type.Optional(
        Type.String({ description: "New topic (stream messages only)" }),
      ),
      propagate_mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("change_one"),
            Type.Literal("change_later"),
            Type.Literal("change_all"),
          ],
          {
            description:
              "How to propagate topic/stream changes. 'change_one' (this msg), 'change_later' (this + later), 'change_all' (all in thread). Default: change_one.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      if (!params.content && !params.topic) {
        throw new Error(
          "Provide at least 'content' or 'topic' to edit.",
        );
      }

      const body = new URLSearchParams();
      if (params.content) body.set("content", params.content);
      if (params.topic) body.set("topic", params.topic);
      if (params.propagate_mode)
        body.set("propagate_mode", params.propagate_mode);

      await zulipFetch(
        `/messages/${params.message_id}`,
        { method: "PATCH", body: body.toString() },
        ctx,
      );

      return {
        content: [
          {
            type: "text",
            text: `Message ${params.message_id} edited.`,
          },
        ],
        details: { messageId: params.message_id },
      };
    },
  });

  // ── zulip_delete_message ─────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_delete_message",
    label: "Zulip Delete Message",
    description: "Delete a Zulip message (your own only)",
    parameters: Type.Object({
      message_id: Type.Number({
        description: "ID of the message to delete",
      }),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      await zulipFetch(
        `/messages/${params.message_id}`,
        { method: "DELETE" },
        ctx,
      );

      return {
        content: [
          {
            type: "text",
            text: `Message ${params.message_id} deleted.`,
          },
        ],
        details: { messageId: params.message_id },
      };
    },
  });

  // ── zulip_add_reaction ───────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_add_reaction",
    label: "Zulip Add Reaction",
    description: "Add an emoji reaction to a Zulip message",
    parameters: Type.Object({
      message_id: Type.Number({
        description: "ID of the message to react to",
      }),
      emoji_name: Type.String({
        description: "Emoji name (e.g., '+1', 'heart', 'thumbs_up')",
      }),
      reaction_type: Type.Optional(
        Type.Union(
          [
            Type.Literal("unicode_emoji"),
            Type.Literal("realm_emoji"),
            Type.Literal("zulip_extra_emoji"),
          ],
          {
            description:
              "Emoji type. Default: unicode_emoji.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const body = new URLSearchParams({
        message_id: String(params.message_id),
        emoji_name: params.emoji_name,
        reaction_type: params.reaction_type ?? "unicode_emoji",
      });

      await zulipFetch(
        "/reactions",
        { method: "POST", body: body.toString() },
        ctx,
      );

      return {
        content: [
          {
            type: "text",
            text: `Added :${params.emoji_name}: to message ${params.message_id}.`,
          },
        ],
        details: {
          messageId: params.message_id,
          emoji: params.emoji_name,
        },
      };
    },
  });

  // ── zulip_remove_reaction ────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_remove_reaction",
    label: "Zulip Remove Reaction",
    description: "Remove your emoji reaction from a Zulip message",
    parameters: Type.Object({
      message_id: Type.Number({
        description: "ID of the message",
      }),
      emoji_name: Type.String({
        description: "Emoji name to remove",
      }),
      reaction_type: Type.Optional(
        Type.Union(
          [
            Type.Literal("unicode_emoji"),
            Type.Literal("realm_emoji"),
            Type.Literal("zulip_extra_emoji"),
          ],
          {
            description:
              "Emoji type. Default: unicode_emoji.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const body = new URLSearchParams({
        message_id: String(params.message_id),
        emoji_name: params.emoji_name,
        reaction_type: params.reaction_type ?? "unicode_emoji",
      });

      await zulipFetch(
        "/reactions",
        { method: "DELETE", body: body.toString() },
        ctx,
      );

      return {
        content: [
          {
            type: "text",
            text: `Removed :${params.emoji_name}: from message ${params.message_id}.`,
          },
        ],
        details: {
          messageId: params.message_id,
          emoji: params.emoji_name,
        },
      };
    },
  });

  // ── zulip_search_messages ────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_search_messages",
    label: "Zulip Search Messages",
    description:
      "Search Zulip messages by keyword, sender, stream, or other filters",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query. Supports operators: 'stream:NAME', 'topic:NAME', 'sender:EMAIL', 'near:ID', 'has:image', 'has:link'. Combine with spaces.",
      }),
      num_results: Type.Optional(
        Type.Number({
          description: "Max results to return",
          default: 10,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const query = new URLSearchParams({
        narrow: JSON.stringify([{ operator: "search", operand: params.query }]),
        anchor: "newest",
        num_before: String(params.num_results ?? 10),
        num_after: "0",
        apply_markdown: "true",
      });

      const data = (await zulipFetch(
        `/messages?${query}`,
        {},
        ctx,
      )) as {
        messages: Array<{
          id: number;
          sender_email: string;
          sender_full_name: string;
          subject: string;
          stream_name?: string;
          content: string;
          timestamp: number;
          reactions: Array<{
            emoji_name: string;
            user: { full_name: string };
          }>;
        }>;
      };

      if (data.messages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results for query: ${params.query}`,
            },
          ],
          details: { count: 0, query: params.query },
        };
      }

      const lines = data.messages.map((msg) => renderMessage(msg, false));

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.messages.length} result(s) for "${params.query}":\n\n${lines.join("\n\n---\n\n")}`,
          },
        ],
        details: {
          count: data.messages.length,
          query: params.query,
        },
      };
    },
  });

  // ── zulip_get_streams ────────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_get_streams",
    label: "Zulip Get Streams",
    description: "List available Zulip streams",
    parameters: Type.Object({
      include_all: Type.Optional(
        Type.Boolean({
          description: "Include all streams including unsubscribed",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const includeAll = params.include_all ? "true" : "false";
      const data = (await zulipFetch(
        `/users/me/subscriptions?include_all=${includeAll}`,
        {},
        ctx,
      )) as {
        subscriptions: Array<{
          name: string;
          stream_id: number;
          description: string;
        }>;
      };

      if (data.subscriptions.length === 0) {
        return {
          content: [{ type: "text", text: "No streams found." }],
          details: { count: 0 },
        };
      }

      const lines = data.subscriptions.map(
        (s) => `#${s.name} (id: ${s.stream_id})\n  ${s.description}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.subscriptions.length} stream(s):\n\n${lines.join("\n\n")}`,
          },
        ],
        details: { count: data.subscriptions.length },
      };
    },
  });

  // ── zulip_get_topics ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_get_topics",
    label: "Zulip Get Topics",
    description: "List topics in a Zulip stream",
    parameters: Type.Object({
      stream: Type.String({
        description: "Stream name to fetch topics from",
      }),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const data = (await zulipFetch(
        `/users/me/${encodeURIComponent(params.stream)}/topics`,
        {},
        ctx,
      )) as {
        topics: Array<{ name: string; max_id: number }>;
      };

      if (data.topics.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No topics found in stream "${params.stream}".`,
            },
          ],
          details: { count: 0 },
        };
      }

      const lines = data.topics.map((t) => `- ${t.name}`);

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.topics.length} topic(s) in "${params.stream}":\n\n${lines.join("\n")}`,
          },
        ],
        details: { count: data.topics.length },
      };
    },
  });

  // ── zulip_create_draft ───────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_create_draft",
    label: "Zulip Create Draft",
    description:
      "Save a draft message on Zulip for later editing and sending",
    parameters: Type.Object({
      type: Type.Union(
        [Type.Literal("stream"), Type.Literal("private")],
        {
          description:
            "'stream' for stream draft, 'private' for DM draft",
        },
      ),
      to: Type.String({
        description:
          "Stream name (for stream) or comma-separated emails (for DM)",
      }),
      topic: Type.Optional(
        Type.String({
          description: "Topic name (required for stream drafts)",
        }),
      ),
      content: Type.String({
        description: "Draft content (Markdown supported)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const body = new URLSearchParams({
        type: params.type,
        to: params.to,
        content: params.content,
        ...(params.topic ? { topic: params.topic } : {}),
      });

      const data = (await zulipFetch(
        "/drafts",
        { method: "POST", body: body.toString() },
        ctx,
      )) as { id: number };

      return {
        content: [
          {
            type: "text",
            text: `Draft saved (id: ${data.id}). Edit and send from Zulip UI or with /zulip-drafts.`,
          },
        ],
        details: { draftId: data.id },
      };
    },
  });

  // ── zulip_get_drafts ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_get_drafts",
    label: "Zulip Get Drafts",
    description: "List saved draft messages on Zulip",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _update, ctx) {
      const data = (await zulipFetch("/drafts", {}, ctx)) as {
        drafts: Array<{
          id: number;
          type: string;
          to: number[] | string;
          topic?: string;
          content: string;
        }>;
      };

      if (data.drafts.length === 0) {
        return {
          content: [{ type: "text", text: "No drafts found." }],
          details: { count: 0 },
        };
      }

      const lines = data.drafts.map((d) => {
        const toStr = Array.isArray(d.to)
          ? d.to.join(", ")
          : d.to;
        const topic = d.topic ? ` > ${d.topic}` : "";
        return `[${d.type}: ${toStr}${topic}] (id: ${d.id})\n${d.content}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.drafts.length} draft(s):\n\n${lines.join("\n\n---\n\n")}`,
          },
        ],
        details: { count: data.drafts.length },
      };
    },
  });

  // ── zulip_delete_draft ───────────────────────────────────────────────────

  pi.registerTool({
    name: "zulip_delete_draft",
    label: "Zulip Delete Draft",
    description: "Delete a saved draft message on Zulip",
    parameters: Type.Object({
      draft_id: Type.Number({
        description: "ID of the draft to delete",
      }),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      await zulipFetch(
        `/drafts/${params.draft_id}`,
        { method: "DELETE" },
        ctx,
      );

      return {
        content: [
          {
            type: "text",
            text: `Draft ${params.draft_id} deleted.`,
          },
        ],
        details: { draftId: params.draft_id },
      };
    },
  });

  // ── /zulip ───────────────────────────────────────────────────────────────

  pi.registerCommand("zulip", {
    description: "Show Zulip integration status",
    handler: async (_args, ctx) => {
      try {
        const config = getZulipConfig();
        const info = (await zulipFetch("/register", {}, ctx)) as {
          queue_id: string;
        };
        ctx.ui.notify(
          `Zulip connected: ${config.server}\nQueue ID: ${info.queue_id}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Zulip error: ${error instanceof Error ? error.message : error}`,
          "error",
        );
      }
    },
  });

// ── Guard: require confirmation before sending messages ──────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "zulip_send_message") {
      const content = event.input.content as unknown as string | undefined;
      const preview = ctx.ui.theme.bold?.(content?.slice(0, 120) ?? "") ?? content?.slice(0, 120) ?? "";
      const ok = await ctx.ui.confirm(
        "Send Zulip message?",
        `To: ${event.input.to}\nTopic: ${event.input.topic ?? "(none)"}\n\n${preview}`,
      );
      if (!ok) return { block: true, reason: "Message send blocked by user", terminate: true };
    }
  });

  // ── /zulip-setup ─────────────────────────────────────────────────────────

  pi.registerCommand("zulip-setup", {
    description:
      "Interactively configure Zulip credentials for this session",
    handler: async (_args, ctx) => {
      // Check if already configured
      if (
        process.env.ZULIP_SERVER &&
        process.env.ZULIP_EMAIL &&
        process.env.ZULIP_API_KEY
      ) {
        const ok = await ctx.ui.confirm(
          "Zulip already configured",
          `Server: ${process.env.ZULIP_SERVER}\nEmail: ${process.env.ZULIP_EMAIL}\nReconfigure?`,
        );
        if (!ok) {
          const info = (await zulipFetch("/register", {}, ctx)) as {
            queue_id: string;
          };
          ctx.ui.notify(
            `Connection OK. Queue: ${info.queue_id}`,
            "info",
          );
          return;
        }
      }

      // Interactive setup
      const server = await ctx.ui.input(
        "Zulip Server",
        "e.g. https://your-org.zulipchat.com",
      );
      if (!server) return;

      const email = await ctx.ui.input(
        "Zulip Email",
        "Your Zulip login email",
      );
      if (!email) return;

      const apiKey = await ctx.ui.input(
        "Zulip API Key",
        "Find in Settings > Account & privacy > API key",
      );
      if (!apiKey) return;

      // Validate
      const prev = cachedConfig ? { ...cachedConfig } : null;
      cachedConfig = {
        server: server.trim(),
        email: email.trim(),
        apiKey: apiKey.trim(),
      };

      try {
        const info = (await zulipFetch("/register", {}, ctx)) as {
          queue_id: string;
        };
        ctx.ui.notify(
          `Zulip configured and verified!\nServer: ${cachedConfig.server}\nQueue: ${info.queue_id}`,
          "info",
        );
      } catch (error) {
        cachedConfig = prev;
        ctx.ui.notify(
          `Connection failed: ${error instanceof Error ? error.message : error}`,
          "error",
        );
      }
    },
  });
}
