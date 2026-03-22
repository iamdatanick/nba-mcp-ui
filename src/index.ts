import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { DASHBOARD_HTML } from "./generated/dashboard-html.js";

const DASHBOARD_URI = "ui://nba-mcp-ui/dashboard";
const NBA_MCP_URL = "https://nbamcp.com";

export class NbaMcpUiAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "NBA MCP Dashboard",
    version: "1.0.0",
  });

  async init(): Promise<void> {
    registerAppTool(
      this.server,
      "nba_dashboard",
      {
        title: "NBA Dashboard",
        description:
          "Opens an interactive NBA dashboard with today's scoreboard, " +
          "team schedules, and league leaders. Browse games, check scores, " +
          "view upcoming matchups, and see stat leaders across the NBA.",
        inputSchema: {
          tab: z
            .enum(["scoreboard", "schedule", "leaders"])
            .optional()
            .describe("Tab to open (default: scoreboard)"),
          team: z
            .string()
            .optional()
            .describe("Pre-select team by abbreviation, e.g. 'SAS', 'LAL'"),
          date: z
            .string()
            .optional()
            .describe("Date in YYYYMMDD format, e.g. '20260322'"),
          stat: z
            .enum(["PTS", "AST", "REB", "STL", "BLK"])
            .optional()
            .describe("Stat category for leaders tab"),
        },
        annotations: { readOnlyHint: true },
        _meta: {
          ui: {
            resourceUri: DASHBOARD_URI,
            prefersBorder: false,
          },
        },
      },
      async ({ tab, team, date, stat }) => ({
        structuredContent: {
          tab: tab ?? "scoreboard",
          team: team ?? null,
          date: date ?? null,
          stat: stat ?? null,
        },
        content: [
          {
            type: "text" as const,
            text:
              `Opening NBA Dashboard${tab ? ` on ${tab} tab` : ""}` +
              `${team ? ` for ${team}` : ""}` +
              `${date ? ` on ${date}` : ""}` +
              `${stat ? ` showing ${stat} leaders` : ""}.`,
          },
        ],
      }),
    );

    registerAppResource(
      this.server,
      "dashboard_ui",
      DASHBOARD_URI,
      {
        description: "NBA Dashboard interactive UI",
        mimeType: RESOURCE_MIME_TYPE,
        _meta: { ui: { prefersBorder: false } },
      },
      async () => ({
        contents: [
          {
            uri: DASHBOARD_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: DASHBOARD_HTML,
            _meta: {
              ui: {
                csp: {
                  connectDomains: [NBA_MCP_URL],
                },
              },
            },
          },
        ],
      }),
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return NbaMcpUiAgent.serve("/mcp").fetch(request, env, ctx);
    }
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      return NbaMcpUiAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          name: "nba-mcp-ui",
          version: "1.0.0",
          status: "ok",
          endpoints: { mcp: "/mcp", sse: "/sse" },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
