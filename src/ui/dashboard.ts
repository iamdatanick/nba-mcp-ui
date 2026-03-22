import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";

// ── Types ───────────────────────────────────────────────────────────
interface Team {
  id: number; name: string; abbreviation: string;
  city: string; nickname: string;
}
interface GameData {
  date: string; total_games: number;
  games: Array<Record<string, unknown>>;
}
interface LeaderEntry {
  rank: number;
  player: { name: string; id: number; team: string };
  stats: Record<string, number>;
}
interface LeadersData {
  category: string; season: string;
  leaders: LeaderEntry[];
}
interface ScheduleData {
  team_id: string;
  upcoming_games: Array<Record<string, unknown>>;
  summary: { total_upcoming: number; next_game: unknown };
}

// ── Direct MCP Fetch (portal pattern -- bypasses callServerTool) ────
const NBA_MCP_URL = "https://nbamcp.com";
let _sessionId: string | null | undefined = undefined;
const TOOL_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function ensureSession(): Promise<void> {
  if (_sessionId !== undefined) return;
  try {
    const resp = await fetch(NBA_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "NBA MCP Dashboard", version: "1.0.0" },
      }}),
    });
    _sessionId = resp.headers.get("mcp-session-id");
  } catch { _sessionId = null; }
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const execute = async (): Promise<T> => {
    await ensureSession();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (_sessionId) headers["Mcp-Session-Id"] = _sessionId;
    const resp = await fetch(NBA_MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(),
        method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await resp.text();
    type McpResp = {
      result?: { isError?: boolean; structuredContent?: unknown;
        content?: { type: string; text?: string }[] };
      error?: { message?: string };
    };
    let json: McpResp;
    if (text.startsWith("event:") || text.startsWith("data:")) {
      const line = text.split("\n").find((l: string) => l.startsWith("data:"));
      if (!line) throw new Error(`No data in response for ${name}`);
      json = JSON.parse(line.slice(5)) as McpResp;
    } else {
      json = JSON.parse(text) as McpResp;
    }
    if (json.error) throw new Error(json.error.message ?? `Tool ${name} failed`);
    const result = json.result!;
    if (result.isError) {
      const errText = result.content?.find((c) => c.type === "text")?.text;
      throw new Error(errText ?? `Tool ${name} returned an error`);
    }
    if (result.structuredContent) return result.structuredContent as T;
    const textContent = result.content?.find((c) => c.type === "text");
    if (textContent?.text) return JSON.parse(textContent.text) as T;
    throw new Error(`No content from ${name}`);
  };
  return withTimeout(execute(), TOOL_TIMEOUT_MS, `callTool(${name})`);
}

// ── DOM Helpers ─────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function clear(parent: HTMLElement) { while (parent.firstChild) parent.removeChild(parent.firstChild); }

// ── State ───────────────────────────────────────────────────────────
let activeTab = "scoreboard";
let teams: Team[] = [];

// ── Tab Navigation ──────────────────────────────────────────────────
function switchTab(tab: string): void {
  activeTab = tab;
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
  });
  document.querySelectorAll<HTMLElement>(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${tab}`);
  });
}

// ── Scoreboard ──────────────────────────────────────────────────────
async function loadScoreboard(dateStr?: string): Promise<void> {
  const grid = $("score-grid");
  clear(grid);
  const loading = el("div", "loading");
  loading.textContent = "Loading games";
  grid.appendChild(loading);

  try {
    let data: GameData;
    if (dateStr) {
      const d = dateStr.replace(/-/g, "");
      data = await callTool<GameData>("get_games_by_date", {
        date: d, query_reason: `Dashboard: games for ${dateStr}`,
      });
    } else {
      data = await callTool<GameData>("get_todays_games", {
        query_reason: "Dashboard: today's scoreboard",
      });
    }
    clear(grid);

    if (!data.games || data.games.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = `No games found for ${data.date || "today"}`;
      grid.appendChild(empty);
      return;
    }

    for (const game of data.games) {
      const g = game as Record<string, unknown>;
      const card = el("div", "game-card");

      // Status badge
      const statusStr = String(g.status || g.game_status || "");
      const statusEl = el("div", "status");
      if (/live|progress/i.test(statusStr)) {
        statusEl.className = "status status-live";
        statusEl.textContent = "LIVE";
      } else if (/final/i.test(statusStr)) {
        statusEl.className = "status status-final";
        statusEl.textContent = "FINAL";
      } else {
        statusEl.className = "status status-upcoming";
        statusEl.textContent = statusStr || "UPCOMING";
      }
      card.appendChild(statusEl);

      // Matchup
      const home = g.home_team as Record<string, unknown> | undefined;
      const away = g.away_team as Record<string, unknown> | undefined;
      const matchup = el("div", "matchup");
      const hName = home?.abbreviation || home?.name || g.home_team_name || "HOME";
      const aName = away?.abbreviation || away?.name || g.away_team_name || "AWAY";
      matchup.textContent = `${aName} @ ${hName}`;
      card.appendChild(matchup);

      // Score
      const hScore = g.home_team_score ?? (home as Record<string, unknown>)?.score ?? "";
      const aScore = g.away_team_score ?? (away as Record<string, unknown>)?.score ?? "";
      if (hScore !== "" || aScore !== "") {
        const score = el("div", "score");
        score.textContent = `${aScore} - ${hScore}`;
        card.appendChild(score);
      }

      // Time / arena
      const meta = el("div", "meta");
      const timeStr = g.game_time || g.start_time || g.arena || "";
      meta.textContent = String(timeStr);
      card.appendChild(meta);

      grid.appendChild(card);
    }

    updateCtx(`Scoreboard: ${data.total_games} games on ${data.date || "today"}`);
  } catch (err) {
    clear(grid);
    const errEl = el("div", "empty-state");
    errEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    grid.appendChild(errEl);
  }
}

// ── Schedule ────────────────────────────────────────────────────────
async function loadTeams(): Promise<void> {
  try {
    const data = await callTool<{ teams: Team[] }>("get_all_teams", {
      query_reason: "Dashboard: loading team list for picker",
    });
    teams = data.teams.sort((a, b) => a.name.localeCompare(b.name));
    const select = $("sched-team") as HTMLSelectElement;
    clear(select);
    const defOpt = el("option");
    defOpt.value = "";
    defOpt.textContent = "Select a team...";
    select.appendChild(defOpt);
    for (const t of teams) {
      const opt = el("option");
      opt.value = String(t.id);
      opt.textContent = `${t.abbreviation} - ${t.name}`;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error("loadTeams failed:", err);
  }
}

async function loadSchedule(teamId: string): Promise<void> {
  const list = $("sched-list");
  clear(list);
  const loading = el("div", "loading");
  loading.textContent = "Loading schedule";
  list.appendChild(loading);

  try {
    const data = await callTool<ScheduleData>("get_team_schedule", {
      team_id: teamId, query_reason: `Dashboard: schedule for team ${teamId}`,
    });
    clear(list);

    const games = data.upcoming_games || [];
    if (games.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = "No upcoming games found";
      list.appendChild(empty);
      return;
    }

    for (const game of games) {
      const g = game as Record<string, unknown>;
      const row = el("div", "schedule-row");

      const dateEl = el("div", "date");
      dateEl.textContent = String(g.date || g.game_date || "");
      row.appendChild(dateEl);

      const teamsEl = el("div", "teams");
      const home = g.home_team as Record<string, unknown> | undefined;
      const away = g.away_team as Record<string, unknown> | undefined;
      const hName = home?.abbreviation || home?.name || g.home_team_name || g.matchup || "";
      const aName = away?.abbreviation || away?.name || g.away_team_name || "";
      teamsEl.textContent = aName ? `${aName} @ ${hName}` : String(hName);
      row.appendChild(teamsEl);

      const venue = el("div", "venue");
      venue.textContent = String(g.arena || g.venue || g.time || "");
      row.appendChild(venue);

      list.appendChild(row);
    }

    const team = teams.find((t) => String(t.id) === teamId);
    updateCtx(`Schedule: ${games.length} upcoming games for ${team?.name || teamId}`);
  } catch (err) {
    clear(list);
    const errEl = el("div", "empty-state");
    errEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    list.appendChild(errEl);
  }
}

// ── Leaders ─────────────────────────────────────────────────────────
async function loadLeaders(stat: string, mode: string): Promise<void> {
  const content = $("leaders-content");
  clear(content);
  const loading = el("div", "loading");
  loading.textContent = "Loading leaders";
  content.appendChild(loading);

  try {
    const data = await callTool<LeadersData>("get_league_leaders", {
      stat_category: stat,
      per_mode: mode,
      query_reason: `Dashboard: ${stat} leaders (${mode})`,
    });
    clear(content);

    if (!data.leaders || data.leaders.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = "No leader data available";
      content.appendChild(empty);
      return;
    }

    const table = el("table", "leader-table");
    const thead = el("thead");
    const hrow = el("tr");
    const statKey = stat.toLowerCase();
    for (const label of ["#", "Player", "Team", "GP", stat, "MIN"]) {
      const th = el("th");
      th.textContent = label;
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const entry of data.leaders) {
      const row = el("tr");

      const rankTd = el("td", "rank");
      rankTd.textContent = String(entry.rank);
      row.appendChild(rankTd);

      const nameTd = el("td", "player-name");
      nameTd.textContent = entry.player.name;
      row.appendChild(nameTd);

      const teamTd = el("td", "team-abbr");
      teamTd.textContent = entry.player.team;
      row.appendChild(teamTd);

      const gpTd = el("td");
      gpTd.textContent = String(entry.stats.games_played ?? "");
      row.appendChild(gpTd);

      const statTd = el("td", "stat-val");
      const statMap: Record<string, string> = {
        pts: "points", ast: "assists", reb: "rebounds",
        stl: "steals", blk: "blocks",
      };
      const val = entry.stats[statMap[statKey] ?? statKey];
      statTd.textContent = val != null ? String(val) : "";
      row.appendChild(statTd);

      const minTd = el("td");
      minTd.textContent = String(entry.stats.minutes_per_game ?? "");
      row.appendChild(minTd);

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    content.appendChild(table);

    updateCtx(`Leaders: Top ${data.leaders.length} in ${stat} (${mode})`);
  } catch (err) {
    clear(content);
    const errEl = el("div", "empty-state");
    errEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    content.appendChild(errEl);
  }
}

// ── Context Helper ──────────────────────────────────────────────────
let _app: App | null = null;

function updateCtx(text: string): void {
  if (!_app) return;
  _app.updateModelContext({
    content: [{ type: "text" as const, text }],
  }).catch(() => {});
}

// ── Init ────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  const app = new App(
    { name: "NBA Dashboard", version: "1.0.0" },
    {},
    { autoResize: true },
  );
  _app = app;

  // P0-4: ALL 6 handlers BEFORE connect()

  // 1. Streaming preview
  app.ontoolinputpartial = (params) => {
    const args = params.arguments as Record<string, string> | undefined;
    if (args?.team) {
      const teamSelect = $("sched-team") as HTMLSelectElement;
      const opt = Array.from(teamSelect.options).find(
        (o) => o.textContent?.includes(args.team!) || o.value === args.team,
      );
      if (opt) teamSelect.value = opt.value;
    }
    if (args?.date) {
      ($("score-date") as HTMLInputElement).value = args.date;
    }
  };

  // 2. Final tool arguments
  app.ontoolinput = (params) => {
    const args = params.arguments as {
      tab?: string; team?: string; date?: string; stat?: string;
    } | undefined;
    if (args?.tab) switchTab(args.tab);
  };

  // 3. Tool result
  app.ontoolresult = (result) => {
    const s = result.structuredContent as {
      tab?: string; team?: string; date?: string; stat?: string;
    } | undefined;
    if (s?.tab) switchTab(s.tab);
    loadForActiveTab(s);
  };

  // 4. Cancelled
  app.ontoolcancelled = () => {};

  // 5. Host context (theme, safe area, display mode)
  app.onhostcontextchanged = (ctx) => {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.safeAreaInsets) {
      const { top, right, bottom, left } = ctx.safeAreaInsets;
      document.body.style.padding =
        `${top}px ${right}px ${bottom}px ${left}px`;
    }
  };

  // 6. Teardown
  app.onteardown = async () => ({ status: "closed" });

  // P0-5: Fire-and-forget connect
  app.connect().catch(() => {});

  // ── Wire UI events ──────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab ?? "";
      switchTab(tab);
      loadForActiveTab(null);
    });
  });

  // Scoreboard controls
  $("score-load").addEventListener("click", () => {
    const d = ($("score-date") as HTMLInputElement).value;
    loadScoreboard(d || undefined);
  });
  $("score-today").addEventListener("click", () => {
    ($("score-date") as HTMLInputElement).value = "";
    loadScoreboard();
  });

  // Schedule controls
  $("sched-load").addEventListener("click", () => {
    const id = ($("sched-team") as HTMLSelectElement).value;
    if (id) loadSchedule(id);
  });

  // Leaders controls
  $("leaders-load").addEventListener("click", () => {
    const stat = ($("leaders-stat") as HTMLSelectElement).value;
    const mode = ($("leaders-mode") as HTMLSelectElement).value;
    loadLeaders(stat, mode);
  });

  // Chat bar
  $("chat-send").addEventListener("click", sendChat);
  ($("chat-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });

  // Set today's date as default
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  ($("score-date") as HTMLInputElement).value = `${yyyy}-${mm}-${dd}`;

  // Initial load
  await loadTeams();
  loadForActiveTab(null);
}

function sendChat(): void {
  const input = $("chat-input") as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !_app) return;
  input.value = "";
  _app.message({
    role: "user",
    content: [{ type: "text", text }],
  }).catch(() => {});
}

function loadForActiveTab(
  args: { tab?: string; team?: string; date?: string; stat?: string } | null,
): void {
  if (activeTab === "scoreboard") {
    const dateVal = args?.date
      ? args.date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
      : ($("score-date") as HTMLInputElement).value;
    loadScoreboard(dateVal || undefined);
  } else if (activeTab === "schedule") {
    if (args?.team) {
      // Find team by abbreviation and set picker
      const match = teams.find(
        (t) => t.abbreviation === args.team || String(t.id) === args.team,
      );
      if (match) {
        ($("sched-team") as HTMLSelectElement).value = String(match.id);
        loadSchedule(String(match.id));
      }
    }
  } else if (activeTab === "leaders") {
    const stat = args?.stat || ($("leaders-stat") as HTMLSelectElement).value;
    const mode = ($("leaders-mode") as HTMLSelectElement).value;
    if (stat) {
      ($("leaders-stat") as HTMLSelectElement).value = stat;
      loadLeaders(stat, mode);
    }
  }
}

init();
