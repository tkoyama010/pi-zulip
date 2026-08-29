import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function getZulipConfig() {
  const server = process.env.ZULIP_SERVER;
  const email = process.env.ZULIP_EMAIL;
  const apiKey = process.env.ZULIP_API_KEY;

  if (!server || !email || !apiKey) {
    throw new Error(
      "ZULIP_SERVER, ZULIP_EMAIL, and ZULIP_API_KEY environment variables are required",
    );
  }

  return { server, email, apiKey };
}

function authHeader() {
  const { email, apiKey } = getZulipConfig();
  return "Basic " + Buffer.from(`${email}:${apiKey}`).toString("base64");
}

function zulipUrl(path: string) {
  const { server } = getZulipConfig();
  const base = server.endsWith("/") ? server.slice(0, -1) : server;
  return `${base}/api/v1${path}`;
}

async function zulipFetch(path: string, options?: RequestInit) {
  const response = await fetch(zulipUrl(path), {
    ...options,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zulip API ${response.status}: ${body}`);
  }

  return response.json();
}

export default function (pi: ExtensionAPI) {
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
      include_anchor: Type.Optional(
        Type.Boolean({
          description:
            "Include the anchor message (the latest message seen)",
        }),
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
    }),
    async execute(_toolCallId, params) {
      const narrow: Array<{ operator: string; operand: string | number }> = [];

      if (params.stream) {
        narrow.push({ operator: "stream", operand: params.stream });
      }
      if (params.topic) {
        narrow.push({ operator: "topic", operand: params.topic });
      }

      const query = new URLSearchParams({
        narrow: JSON.stringify(narrow),
        num_before: String(params.num_before ?? 10),
        num_after: String(params.num_after ?? 0),
        include_anchor: String(params.include_anchor ? "true" : "false"),
      });

      const data = await zulipFetch(`/messages?${query}`) as {
        messages: Array<{
          id: number;
          sender_email: string;
          sender_full_name: string;
          subject: string;
          stream_name?: string;
          content: string;
          timestamp: number;
        }>;
      };

      if (data.messages.length === 0) {
        return {
          content: [
            { type: "text", text: "No messages found." },
          ],
          details: { count: 0 },
        };
      }

      const lines = data.messages.map((msg) => {
        const time = new Date(msg.timestamp * 1000).toISOString();
        const stream = msg.stream_name ? `[${msg.stream_name}] ` : "";
        return `[${time}] ${stream}${msg.sender_full_name} (${msg.subject}):\n${msg.content}`;
      });

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

  pi.registerTool({
    name: "zulip_send_message",
    label: "Zulip Send Message",
    description: "Send a message to a Zulip stream or direct message",
    parameters: Type.Object({
      type: Type.Union(
        [Type.Literal("stream"), Type.Literal("private")],
        {
          description:
            "'stream' for stream message, 'private' for DM",
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
    async execute(_toolCallId, params) {
      const body = new URLSearchParams({
        type: params.type,
        to: params.to,
        content: params.content,
        ...(params.topic ? { topic: params.topic } : {}),
      });

      const data = await zulipFetch("/messages", {
        method: "POST",
        body: body.toString(),
      }) as { id: number };

      return {
        content: [
          {
            type: "text",
            text: `Message sent (id: ${data.id}).`,
          },
        ],
        details: { messageId: data.id },
      };
    },
  });

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
    async execute(_toolCallId, params) {
      const includeAll = params.include_all ? "true" : "false";
      const data = await zulipFetch(
        `/users/me/subscriptions?include_all=${includeAll}`,
      ) as {
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

  pi.registerTool({
    name: "zulip_get_topics",
    label: "Zulip Get Topics",
    description: "List topics in a Zulip stream",
    parameters: Type.Object({
      stream: Type.String({
        description: "Stream name to fetch topics from",
      }),
    }),
    async execute(_toolCallId, params) {
      const data = await zulipFetch(
        `/users/me/${encodeURIComponent(params.stream)}/topics`,
      ) as {
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
    async execute(_toolCallId, params) {
      const body = new URLSearchParams({
        type: params.type,
        to: params.to,
        content: params.content,
        ...(params.topic ? { topic: params.topic } : {}),
      });

      const data = await zulipFetch("/drafts", {
        method: "POST",
        body: body.toString(),
      }) as { id: number };

      return {
        content: [
          {
            type: "text",
            text: `Draft saved (id: ${data.id}). Use the Zulip web UI or /drafts command to edit and send later.`,
          },
        ],
        details: { draftId: data.id },
      };
    },
  });

  pi.registerTool({
    name: "zulip_get_drafts",
    label: "Zulip Get Drafts",
    description: "List saved draft messages on Zulip",
    parameters: Type.Object({}),
    async execute(_toolCallId) {
      const data = await zulipFetch("/drafts") as {
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

  pi.registerTool({
    name: "zulip_delete_draft",
    label: "Zulip Delete Draft",
    description: "Delete a saved draft message on Zulip",
    parameters: Type.Object({
      draft_id: Type.Number({
        description: "ID of the draft to delete",
      }),
    }),
    async execute(_toolCallId, params) {
      await zulipFetch(`/drafts/${params.draft_id}`, {
        method: "DELETE",
      });

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

  pi.registerCommand("zulip", {
    description: "Show Zulip integration status",
    handler: async (_args, ctx) => {
      try {
        const config = getZulipConfig();
        const info = await zulipFetch("/register") as {
          queue_id: string;
        };
        ctx.ui.notify(
          `Zulip connected: ${config.server}\nQueue ID: ${info.queue_id}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Zulip connection failed: ${error instanceof Error ? error.message : error}`,
          "error",
        );
      }
    },
  });
}
