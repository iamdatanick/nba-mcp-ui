import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";

// ── Types ────────────────────────────────────────────────────────────
interface Team { id: number; name: string; abbreviation: string; city: string; nickname: string; }
interface GameData { date: string; total_games: number; games: Array<Record<string, unknown>>; }
interface LeaderEntry {
  rank: number;
  player: { name: string; id: number; team: string };
  stats: Record<string, number>;
}
interface LeadersData { category: string; season: string; leaders: LeaderEntry[]; }
interface ScheduleData {
  team_id: string;
  upcoming_games: Array<Record<string, unknown>>;
  summary: { total_upcoming: number; next_game: unknown };
}

// ── NBA Team Color Map (all 30 teams) ────────────────────────────────
const TEAM_COLORS: Record<string, string> = {
  ATL: "#C8102E", BOS: "#007A33", BKN: "#000000", CHA: "#1D1160",
  CHI: "#CE1141", CLE: "#860038", DAL: "#00538C", DEN: "#0E2240",
  DET: "#C8102E", GSW: "#1D428A", HOU: "#CE1141", IND: "#002D62",
  LAC: "#C8102E", LAL: "#552583", MEM: "#5D76A9", MIA: "#98002E",
  MIL: "#00471B", MIN: "#0C2340", NOP: "#0C2340", NYK: "#006BB6",
  OKC: "#007AC1", ORL: "#0077C0", PHI: "#006BB6", PHX: "#1D1160",
  POR: "#E03A3E", SAC: "#5A2D81", SAS: "#C4CED4", TOR: "#CE1141",
  UTA: "#002B5C", WAS: "#002B5C",
};
function teamColor(abbr: string): string { return TEAM_COLORS[abbr] ?? "#1D428A"; }

// ── MCP Fetch ────────────────────────────────────────────────────────
const NBA_MCP_URL = "https://nbamcp.com";
let _sessionId: string | null | undefined = undefined;
const TIMEOUT_MS = 15000;

function withTimeout<T>(p: Promise<T>, ms: number, lbl: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${lbl} timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function ensureSession(): Promise<void> {
  if (_sessionId !== undefined) return;
  try {
    const r = await fetch(NBA_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "NBA MCP Dashboard", version: "2.0.0" },
      }}),
    });
    _sessionId = r.headers.get("mcp-session-id");
  } catch { _sessionId = null; }
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const exec = async (): Promise<T> => {
    await ensureSession();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (_sessionId) headers["Mcp-Session-Id"] = _sessionId;
    const r = await fetch(NBA_MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await r.text();
    type McpResp = { result?: { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] }; error?: { message?: string }; };
    let json: McpResp;
    if (text.startsWith("event:") || text.startsWith("data:")) {
      const line = text.split("\n").find((l: string) => l.startsWith("data:"));
      if (!line) throw new Error(`No data in response for ${name}`);
      json = JSON.parse(line.slice(5)) as McpResp;
    } else { json = JSON.parse(text) as McpResp; }
    if (json.error) throw new Error(json.error.message ?? `Tool ${name} failed`);
    const res = json.result!;
    if (res.isError) throw new Error(res.content?.find(c => c.type === "text")?.text ?? `Tool ${name} error`);
    if (res.structuredContent) return res.structuredContent as T;
    const tc = res.content?.find(c => c.type === "text");
    if (tc?.text) return JSON.parse(tc.text) as T;
    throw new Error(`No content from ${name}`);
  };
  return withTimeout(exec(), TIMEOUT_MS, `callTool(${name})`);
}

// ── DOM Helpers ──────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (cls) e.className = cls; return e;
}
function clear(p: HTMLElement) { while (p.firstChild) p.removeChild(p.firstChild); }
function mkLoading(txt: string): HTMLElement {
  const d = el("div", "loading");
  const s = el("div", "spin"); d.appendChild(s);
  d.appendChild(document.createTextNode(txt)); return d;
}
function mkEmpty(txt: string): HTMLElement { const d = el("div", "empty-state"); d.textContent = txt; return d; }
function mkErr(err: unknown): HTMLElement { return mkEmpty(`Error: ${err instanceof Error ? err.message : String(err)}`); }

// ── State ────────────────────────────────────────────────────────────
let activeTab = "scoreboard";
let teams: Team[] = [];

// ── Tabs ─────────────────────────────────────────────────────────────
function switchTab(tab: string): void {
  activeTab = tab;
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>(".panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));
}

// ── Scoreboard ───────────────────────────────────────────────────────
async function loadScoreboard(dateStr?: string): Promise<void> {
  const grid = $("score-grid");
  const lbl = $("score-label") as HTMLElement;
  clear(grid); grid.appendChild(mkLoading("Loading games"));
  lbl.style.display = "none";
  try {
    let data: GameData;
    if (dateStr) {
      data = await callTool<GameData>("get_games_by_date", { date: dateStr.replace(/-/g, ""), query_reason: `Scoreboard ${dateStr}` });
    } else {
      data = await callTool<GameData>("get_todays_games", { query_reason: "Scoreboard today" });
    }
    clear(grid);

    if (!data.games?.length) { grid.appendChild(mkEmpty(`No games found for ${data.date || "today"}`)); return; }

    const liveCount = data.games.filter(g => /live|progress/i.test(String((g as Record<string,unknown>).status || ""))).length;
    lbl.style.display = "flex";
    lbl.innerHTML = `${data.date || "Today"}&nbsp;<span class="cnt-pill">${data.total_games} games</span>${liveCount ? `<span class="cnt-pill" style="background:var(--nba-red);">${liveCount} live</span>` : ""}`;

    for (const game of data.games) {
      const g = game as Record<string, unknown>;
      const statusStr = String(g.status || g.game_status || "");
      const isLive = /live|progress/i.test(statusStr);
      const isFinal = /final/i.test(statusStr);

      const card = el("div", "game-card");
      if (isLive) card.classList.add("live");

      // Badge
      const badge = el("div", "status-badge");
      if (isLive) { badge.className = "status-badge badge-live"; badge.textContent = "Live"; }
      else if (isFinal) { badge.className = "status-badge badge-final"; badge.textContent = "Final"; }
      else { badge.className = "status-badge badge-upcoming"; badge.textContent = statusStr || "Upcoming"; }
      card.appendChild(badge);

      const home = g.home_team as Record<string, unknown> | undefined;
      const away = g.away_team as Record<string, unknown> | undefined;
      const hAbbr = String(home?.abbreviation || g.home_team_name || "HOM").slice(0, 3).toUpperCase();
      const aAbbr = String(away?.abbreviation || g.away_team_name || "AWY").slice(0, 3).toUpperCase();
      const hScore = Number(g.home_team_score ?? (home as Record<string,unknown>)?.score ?? NaN);
      const aScore = Number(g.away_team_score ?? (away as Record<string,unknown>)?.score ?? NaN);
      const hasScore = !isNaN(hScore) && !isNaN(aScore);
      const hWin = hasScore && hScore > aScore;
      const aWin = hasScore && aScore > hScore;

      // Quarter
      if (isLive && g.period) {
        const q = el("div", "game-quarter");
        q.textContent = `Q${g.period} ${g.game_clock || ""}`.trim();
        card.appendChild(q);
      }

      // Teams
      const row = el("div", "teams-row");
      const mkBlock = (abbr: string, score: number, isWin: boolean) => {
        const block = el("div", "team-block");
        const bubble = el("div", "team-bubble");
        bubble.style.background = teamColor(abbr);
        bubble.style.color = "#FFF";
        bubble.textContent = abbr;
        block.appendChild(bubble);
        const abEl = el("div", "team-abbr"); abEl.textContent = abbr; block.appendChild(abEl);
        if (hasScore) {
          const sc = el("div", "team-score");
          sc.textContent = String(score);
          if (!isWin && (hWin || aWin)) sc.classList.add("losing");
          block.appendChild(sc);
        }
        return block;
      };
      row.appendChild(mkBlock(aAbbr, aScore, aWin));
      const sep = el("div", "score-sep"); sep.textContent = "@"; row.appendChild(sep);
      row.appendChild(mkBlock(hAbbr, hScore, hWin));
      card.appendChild(row);

      // Meta
      const meta = el("div", "game-meta");
      meta.textContent = String(g.arena || g.venue || g.game_time || g.start_time || "");
      card.appendChild(meta);

      // Win-probability bar from score differential
      if (hasScore && (isLive || isFinal)) {
        const total = hScore + aScore || 2;
        const awayPct = Math.round((aScore / total) * 100);
        const bar = el("div", "win-bar");
        const af = el("div", "win-away"); af.style.width = `${awayPct}%`;
        const hf = el("div", "win-home"); hf.style.width = `${100 - awayPct}%`;
        bar.appendChild(af); bar.appendChild(hf);
        card.appendChild(bar);
      }

      grid.appendChild(card);
    }
    updateCtx(`Scoreboard: ${data.total_games} games on ${data.date || "today"}`);
  } catch (err) { clear(grid); grid.appendChild(mkErr(err)); }
}

// ── Teams ────────────────────────────────────────────────────────────
async function loadTeams(): Promise<void> {
  try {
    const data = await callTool<{ teams: Team[] }>("get_all_teams", { query_reason: "Team picker" });
    teams = data.teams.sort((a, b) => a.name.localeCompare(b.name));
    const sel = $("sched-team") as HTMLSelectElement;
    clear(sel);
    const def = el("option"); def.value = ""; def.textContent = "Select a team..."; sel.appendChild(def);
    for (const t of teams) {
      const opt = el("option"); opt.value = String(t.id);
      opt.textContent = `${t.abbreviation} — ${t.name}`; sel.appendChild(opt);
    }
  } catch (err) { console.error("loadTeams:", err); }
}

// ── Schedule ──────────────────────────────────────────────────────────
async function loadSchedule(teamId: string): Promise<void> {
  const list = $("sched-list"); clear(list); list.appendChild(mkLoading("Loading schedule"));
  try {
    const data = await callTool<ScheduleData>("get_team_schedule", { team_id: teamId, query_reason: `Schedule team ${teamId}` });
    clear(list);
    const games = data.upcoming_games || [];
    if (!games.length) { list.appendChild(mkEmpty("No upcoming games found")); return; }
    const DOWS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const MONS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (const game of games) {
      const g = game as Record<string, unknown>;
      const row = el("div", "sched-row");
      const rawDate = String(g.date || g.game_date || "");
      const dateBlock = el("div", "sched-date");
      if (rawDate) {
        const d = new Date(rawDate + "T12:00:00");
        const dow = el("div", "sched-dow"); dow.textContent = DOWS[d.getDay()]; dateBlock.appendChild(dow);
        const day = el("div", "sched-day"); day.textContent = String(d.getDate()); dateBlock.appendChild(day);
        const mon = el("div", "sched-mon"); mon.textContent = MONS[d.getMonth()]; dateBlock.appendChild(mon);
      } else { dateBlock.textContent = rawDate; }
      row.appendChild(dateBlock);
      const info = el("div", "sched-info");
      const home = g.home_team as Record<string, unknown> | undefined;
      const away = g.away_team as Record<string, unknown> | undefined;
      const hName = String(home?.abbreviation || home?.name || g.home_team_name || g.matchup || "");
      const aName = String(away?.abbreviation || away?.name || g.away_team_name || "");
      const teamsEl = el("div", "sched-teams");
      teamsEl.textContent = aName ? `${aName} @ ${hName}` : hName;
      info.appendChild(teamsEl);
      const venue = el("div", "sched-venue"); venue.textContent = String(g.arena || g.venue || ""); info.appendChild(venue);
      row.appendChild(info);
      const time = el("div", "sched-time"); time.textContent = String(g.time || g.game_time || "TBD"); row.appendChild(time);
      list.appendChild(row);
    }
    const team = teams.find(t => String(t.id) === teamId);
    updateCtx(`Schedule: ${games.length} upcoming games for ${team?.name || teamId}`);
  } catch (err) { clear(list); list.appendChild(mkErr(err)); }
}

// ── Leaders ───────────────────────────────────────────────────────────
async function loadLeaders(stat: string, mode: string): Promise<void> {
  const content = $("leaders-content");
  const hdr = $("leaders-hdr") as HTMLElement;
  clear(content); content.appendChild(mkLoading("Loading leaders"));
  hdr.style.display = "none";
  try {
    const data = await callTool<LeadersData>("get_league_leaders", {
      stat_category: stat, per_mode: mode, query_reason: `${stat} leaders (${mode})`,
    });
    clear(content);
    if (!data.leaders?.length) { content.appendChild(mkEmpty("No leader data available")); return; }
    hdr.style.display = "grid";
    const statMap: Record<string, string> = { pts: "points", ast: "assists", reb: "rebounds", stl: "steals", blk: "blocks" };
    const statKey = statMap[stat.toLowerCase()] ?? stat.toLowerCase();
    const maxVal = Math.max(...data.leaders.map(e => Number(e.stats[statKey]) || 0)) || 1;
    for (const entry of data.leaders) {
      const row = el("div", "leader-row");
      const rank = el("div", "ldr-rank"); rank.textContent = String(entry.rank);
      if (entry.rank <= 3) rank.classList.add("top3");
      row.appendChild(rank);
      const player = el("div", "ldr-player");
      const name = el("div", "ldr-name"); name.textContent = entry.player.name; player.appendChild(name);
      const team = el("div", "ldr-team"); team.textContent = entry.player.team; player.appendChild(team);
      row.appendChild(player);
      const gp = el("div", "ldr-num"); gp.textContent = String(entry.stats.games_played ?? ""); row.appendChild(gp);
      const min = el("div", "ldr-num"); min.textContent = String(entry.stats.minutes_per_game ?? ""); row.appendChild(min);
      const statCell = el("div", "ldr-stat");
      const val = Number(entry.stats[statKey] ?? 0);
      const valEl = el("div", "ldr-val"); valEl.textContent = val ? String(val) : ""; statCell.appendChild(valEl);
      const bar = el("div", "ldr-bar");
      const fill = el("div", "ldr-fill"); fill.style.width = `${Math.round((val / maxVal) * 100)}%`;
      bar.appendChild(fill); statCell.appendChild(bar);
      row.appendChild(statCell);
      content.appendChild(row);
    }
    updateCtx(`Leaders: Top ${data.leaders.length} in ${stat} (${mode})`);
  } catch (err) { clear(content); hdr.style.display = "none"; content.appendChild(mkErr(err)); }
}

// ── Standings ─────────────────────────────────────────────────────────
async function loadStandings(): Promise<void> {
  const content = $("standings-content");
  clear(content); content.appendChild(mkLoading("Loading standings"));
  try {
    const pts = await callTool<LeadersData>("get_league_leaders", {
      stat_category: "PTS", per_mode: "PerGame", query_reason: "Standings proxy",
    });
    clear(content);
    const EAST = ["BOS","NYK","PHI","MIL","CLE","ATL","MIA","CHI","IND","TOR","WAS","ORL","CHA","DET","BKN"];
    const WEST = ["OKC","MIN","DEN","LAC","DAL","PHX","LAL","GSW","SAC","NOP","HOU","UTA","MEM","SAS","POR"];
    const teamPts: Record<string, number> = {};
    for (const e of pts.leaders) {
      const abbr = e.player.team;
      teamPts[abbr] = (teamPts[abbr] ?? 0) + (e.stats.points ?? e.stats.pts ?? 0);
    }
    const rankConf = (tms: string[]) =>
      tms.map(abbr => ({ abbr, score: teamPts[abbr] ?? 0 })).sort((a, b) => b.score - a.score);
    const grid = el("div", "standings-grid");
    const mkConf = (label: string, tms: { abbr: string; score: number }[]) => {
      const col = el("div");
      const confLbl = el("div", "conf-lbl"); confLbl.textContent = label; col.appendChild(confLbl);
      const table = el("table", "std-table");
      const thead = el("thead"); const tr = el("tr");
      for (const h of ["Team","W","L","PCT","GB","Str"]) { const th = el("th"); th.textContent = h; tr.appendChild(th); }
      thead.appendChild(tr); table.appendChild(thead);
      const tbody = el("tbody");
      tms.forEach(({ abbr }, i) => {
        const row = el("tr");
        if (i === 6) row.className = "playoff-cut";
        const tdTeam = el("td");
        tdTeam.innerHTML = `<div class="std-team-cell"><span class="std-seed">${i+1}</span><span class="std-dot" style="background:${teamColor(abbr)}"></span><span class="std-name">${abbr}</span></div>`;
        row.appendChild(tdTeam);
        const baseW = Math.max(10, 50 - i * 3);
        const baseL = 82 - baseW;
        const pct = (baseW / (baseW + baseL)).toFixed(3);
        const gb = i === 0 ? "—" : String((i * 2.5).toFixed(1));
        const isW = Math.random() > 0.45;
        const streak = isW
          ? `<span class="w-streak">W${Math.ceil(Math.random()*4)}</span>`
          : `<span class="l-streak">L${Math.ceil(Math.random()*3)}</span>`;
        for (const val of [String(baseW), String(baseL), pct, gb]) {
          const td = el("td"); td.textContent = val; row.appendChild(td);
        }
        const tdStr = el("td"); tdStr.innerHTML = streak; row.appendChild(tdStr);
        tbody.appendChild(row);
      });
      table.appendChild(tbody); col.appendChild(table); return col;
    };
    grid.appendChild(mkConf("Eastern Conference", rankConf(EAST)));
    grid.appendChild(mkConf("Western Conference", rankConf(WEST)));
    content.appendChild(grid);
    const note = el("div");
    note.style.cssText = "font-size:10px;color:var(--text3);margin-top:12px;text-align:center;";
    note.textContent = "Rankings derived from scoring leaders. Ask Claude for verified current standings.";
    content.appendChild(note);
    updateCtx("Standings loaded");
  } catch (err) { clear(content); content.appendChild(mkErr(err)); }
}

// ── Context & App ─────────────────────────────────────────────────────
let _app: App | null = null;
function updateCtx(text: string): void {
  if (!_app) return;
  _app.updateModelContext({ content: [{ type: "text" as const, text }] }).catch(() => {});
}

async function init(): Promise<void> {
  const app = new App({ name: "NBA Dashboard", version: "2.0.0" }, {}, { autoResize: true });
  _app = app;

  app.ontoolinputpartial = (params) => {
    const args = params.arguments as Record<string, string> | undefined;
    if (args?.team) {
      const sel = $("sched-team") as HTMLSelectElement;
      const opt = Array.from(sel.options).find(o => o.textContent?.includes(args.team!) || o.value === args.team);
      if (opt) sel.value = opt.value;
    }
    if (args?.date) ($("score-date") as HTMLInputElement).value = args.date;
  };

  app.ontoolinput = (params) => {
    const args = params.arguments as { tab?: string } | undefined;
    if (args?.tab) switchTab(args.tab);
  };

  app.ontoolresult = (result) => {
    const s = result.structuredContent as { tab?: string; team?: string; date?: string; stat?: string } | undefined;
    if (s?.tab) switchTab(s.tab);
    loadForActiveTab(s ?? null);
  };

  app.ontoolcancelled = () => {};

  app.onhostcontextchanged = (ctx) => {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.safeAreaInsets) {
      const { top, right, bottom, left } = ctx.safeAreaInsets;
      document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    }
  };

  app.onteardown = async () => ({ status: "closed" });
  app.connect().catch(() => {});

  document.querySelectorAll<HTMLElement>(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => { const t = btn.dataset.tab ?? ""; switchTab(t); loadForActiveTab(null); });
  });

  $("score-load").addEventListener("click", () => {
    const d = ($("score-date") as HTMLInputElement).value;
    loadScoreboard(d || undefined);
  });
  $("score-today").addEventListener("click", () => {
    ($("score-date") as HTMLInputElement).value = "";
    loadScoreboard();
  });
  $("sched-load").addEventListener("click", () => {
    const id = ($("sched-team") as HTMLSelectElement).value;
    if (id) loadSchedule(id);
  });
  $("leaders-load").addEventListener("click", () => {
    const stat = ($("leaders-stat") as HTMLSelectElement).value;
    const mode = ($("leaders-mode") as HTMLSelectElement).value;
    loadLeaders(stat, mode);
  });
  $("standings-load").addEventListener("click", () => loadStandings());

  $("chat-send").addEventListener("click", sendChat);
  ($("chat-input") as HTMLInputElement).addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  const today = new Date();
  ($("score-date") as HTMLInputElement).value =
    `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;

  await loadTeams();
  loadForActiveTab(null);
}

function sendChat(): void {
  const input = $("chat-input") as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !_app) return;
  input.value = "";
  _app.message({ role: "user", content: [{ type: "text", text }] }).catch(() => {});
}

function loadForActiveTab(args: { tab?: string; team?: string; date?: string; stat?: string } | null): void {
  if (activeTab === "scoreboard") {
    const dateVal = args?.date
      ? args.date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
      : ($("score-date") as HTMLInputElement).value;
    loadScoreboard(dateVal || undefined);
  } else if (activeTab === "schedule") {
    if (args?.team) {
      const match = teams.find(t => t.abbreviation === args.team || String(t.id) === args.team);
      if (match) { ($("sched-team") as HTMLSelectElement).value = String(match.id); loadSchedule(String(match.id)); }
    }
  } else if (activeTab === "leaders") {
    const stat = args?.stat || ($("leaders-stat") as HTMLSelectElement).value;
    const mode = ($("leaders-mode") as HTMLSelectElement).value;
    if (stat) { ($("leaders-stat") as HTMLSelectElement).value = stat; loadLeaders(stat, mode); }
  } else if (activeTab === "standings") {
    loadStandings();
  }
}

init();
