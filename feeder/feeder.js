// NBA Hub feeder: ESPN/nbaapi.com sync (current season every 4 hours) into SQL Server 2005 (the IIS version in ../iis-sql2005).
// Covers ALL 30 teams for each configured season. For the current season the roster is the live ESPN
// roster; for a completed season it's everyone who played, from nbaapi. Seasons use the end-year
// (2027 = the 2026-27 season). Runs on a host with internet access; the IIS/SQL 2005 server stays offline.
const sql = require('mssql');
const axios = require('axios');
const cron = require('node-cron');

const db = new sql.ConnectionPool({
  server: process.env.DB_HOST,
  port: 1433,
  user: process.env.DB_USER || 'nbahub_feeder',
  password: process.env.DB_PASSWORD,
  database: 'roster_db',
  options: {
    tdsVersion: '7_2', encrypt: false, trustServerCertificate: true,
    cryptoCredentialsDetails: { minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' },  // SQL 2005 login = TLS 1.0
  },
  pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
});

// ESPN abbreviation -> nbaapi (basketball-reference) abbreviation, where they differ.
const ESPN_HEAD = 'https://a.espncdn.com/i/headshots/nba/players/full/';
const BREF_HEAD = 'https://www.basketball-reference.com/req/202106291/images/headshots/';
const NBAAPI_ABBR = { BKN: 'BRK', CHA: 'CHO', GS: 'GSW', NO: 'NOP', NY: 'NYK', PHX: 'PHO', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' };
function currentSeasonEndYear(d = new Date()) { return (d.getMonth() + 1) >= 10 ? d.getFullYear() + 1 : d.getFullYear(); }
const SEASONS = (process.env.NBA_SEASONS || String(process.env.NBA_SEASON || currentSeasonEndYear()))
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
const SYNC_CRON = process.env.SYNC_CRON || '0 */4 * * *';   // every 4 hours
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalize(name) {
  return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function extractStats(p) {
  const gp = parseInt(p.games || 1, 10) || 1;
  const avg = (v) => (parseFloat(v || 0) / gp).toFixed(1);
  const fmt = (v) => parseFloat(v || 0).toFixed(1);
  const pct = (v) => (parseFloat(v || 0) * 100).toFixed(1);
  return { ppg: avg(p.points), rpg: avg(p.totalRb), apg: avg(p.assists), spg: avg(p.steals), bpg: avg(p.blocks),
           mpg: fmt(p.minutesPg), fgp: pct(p.fieldPercent), tpp: pct(p.threePercent), ftp: pct(p.ftPercent), gp: String(p.games || 0) };
}
const ZERO = { ppg: '0.0', rpg: '0.0', apg: '0.0', spg: '0.0', bpg: '0.0', mpg: '0.0', fgp: '0.0', tpp: '0.0', ftp: '0.0', gp: '0' };

async function fetchTeams() {
  const r = await axios.get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams', { timeout: 15000 });
  return (r.data?.sports?.[0]?.leagues?.[0]?.teams || []).map(t => {
    const tm = t.team;
    return { id: tm.id, abbr: tm.abbreviation, name: tm.displayName,
             logo: (tm.logos || [])[0]?.href || `https://a.espncdn.com/i/teamlogos/nba/500/${tm.abbreviation.toLowerCase()}.png`,
             nbaapi: NBAAPI_ABBR[tm.abbreviation] || tm.abbreviation };
  });
}

async function fetchRoster(teamId) {
  const r = await axios.get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/roster`, { timeout: 12000 });
  return (r.data?.athletes || []).map(a => {
    const inj = (a.injuries || [])[0];
    let detail = inj ? (inj.longComment || inj.shortComment || inj.details?.type?.description || null) : null;
    if (detail) { detail = detail.replace(/<[^>]+>/g, '').trim(); if (detail.length > 200) detail = detail.slice(0, 197) + '...'; }
    return { num: a.jersey || '', name: a.displayName, pos: (a.position?.abbreviation) || '', espnId: String(a.id),
             injury: inj ? inj.status : null, injuryDetail: detail };
  }).filter(p => p.name);
}

// BOS/nbaapi totals for a team-season, deduped by player (keep most games - drops playoff/partial rows).
async function fetchTotals(nbaapiAbbr, season) {
  try {
    const res = await axios.get('https://api.server.nbaapi.com/api/playertotals',
      { params: { team: nbaapiAbbr, season, isPlayoff: false, pageSize: 100 }, timeout: 15000 });
    const m = new Map();
    for (const p of res.data?.data || []) {
      const k = normalize(p.playerName), e = m.get(k);
      if (!e || parseInt(p.games || 0, 10) > parseInt(e.games || 0, 10)) m.set(k, p);
    }
    return [...m.values()];
  } catch (err) { return []; }
}

// ESPN per-game stats for every player in a season, keyed by ESPN athlete id. nbaapi.com lags the live
// season by weeks (it had nothing for 2026-27 in late October), so this is the current season's main source.
// Returns { byId: stats rows for the roster, list: per-game numbers for the MVP race and leaders }.
async function fetchEspnStats(season) {
  const byId = {}, list = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const res = await axios.get('https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete',
        { params: { region: 'us', lang: 'en', contentorigin: 'espn', isqualified: false, season, seasontype: 2, limit: 200, page }, timeout: 20000 });
      const names = {};
      for (const c of res.data?.categories || []) names[c.name] = c.names || [];
      for (const a of res.data?.athletes || []) {
        const v = {};
        for (const c of a.categories || []) (names[c.name] || []).forEach((n, i) => { v[n] = (c.totals || c.values || [])[i]; });
        const fmt = (x) => parseFloat(x || 0).toFixed(1);
        byId[String(a.athlete?.id)] = { ppg: fmt(v.avgPoints), rpg: fmt(v.avgRebounds), apg: fmt(v.avgAssists), spg: fmt(v.avgSteals), bpg: fmt(v.avgBlocks),
          mpg: fmt(v.minutes), fgp: fmt(v.fieldGoalPct), tpp: fmt(v.threePointFieldGoalPct), ftp: fmt(v.freeThrowPct), gp: String(parseInt(v.gamesPlayed || 0, 10)) };
        const n = (x) => parseFloat(x || 0);
        list.push({ name: a.athlete?.displayName, team: a.athlete?.teamShortName || '—', gp: parseInt(v.gamesPlayed || 0, 10),
          pts: n(v.avgPoints), reb: n(v.avgRebounds), ast: n(v.avgAssists), stl: n(v.avgSteals), blk: n(v.avgBlocks),
          // NBA efficiency (EFF) per game: PTS + REB + AST + STL + BLK - missed FG - missed FT - TOV
          eff: n(v.avgPoints) + n(v.avgRebounds) + n(v.avgAssists) + n(v.avgSteals) + n(v.avgBlocks)
               - (n(v.avgFieldGoalsAttempted) - n(v.avgFieldGoalsMade)) - (n(v.avgFreeThrowsAttempted) - n(v.avgFreeThrowsMade)) - n(v.avgTurnovers) });
      }
      if (page >= (res.data?.pagination?.pages || 1)) break;
    }
  } catch (err) { console.error('  ESPN stats fetch failed:', err.message); }
  return { byId, list };
}

async function getSeasonPlayers(team, season, espnStats = {}) {
  if (season === currentSeasonEndYear()) {
    const roster = await fetchRoster(team.id);
    const statsMap = {};
    for (const p of await fetchTotals(team.nbaapi, season)) statsMap[normalize(p.playerName)] = extractStats(p);
    return roster.map(r => ({ ...r, photo: r.espnId ? ESPN_HEAD + r.espnId + '.png' : '',
      stats: espnStats[r.espnId] || statsMap[normalize(r.name)] || ZERO }));
  }
  return (await fetchTotals(team.nbaapi, season)).map(p => ({
    num: '', name: p.playerName, pos: p.position || '', espnId: '', photo: p.playerId ? BREF_HEAD + p.playerId + '.jpg' : '', injury: null, injuryDetail: null, stats: extractStats(p) }));
}

async function fetchSchedule(teamId, season) {
  const r = await axios.get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/schedule`,
    { params: { season }, timeout: 10000 });
  const events = r.data?.events || [];
  const finished = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
  const upcoming = events.filter(e => !e.competitions?.[0]?.status?.type?.completed);
  const lastGames = finished.slice(-3).map(e => {
    const comp = e.competitions[0];
    const me = comp.competitors.find(c => String(c.team?.id) === String(teamId));
    const opp = comp.competitors.find(c => String(c.team?.id) !== String(teamId));
    const ms = String(me?.score?.displayValue ?? me?.score ?? '0'), os = String(opp?.score?.displayValue ?? opp?.score ?? '0');
    return { result: parseInt(ms) > parseInt(os) ? 'W' : 'L', score: `${ms}-${os}`, opp: opp?.team?.abbreviation || '?', isHome: me?.homeAway === 'home' };
  });
  let playoffStart = null;
  for (let i = 0; i < upcoming.length - 1; i++) {
    const a = new Date(upcoming[i].date), b = new Date(upcoming[i + 1].date);
    if ((b - a) > 10 * 24 * 60 * 60 * 1000) { playoffStart = b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase(); break; }
  }
  return { played: finished.length, remaining: upcoming.length, playoffStart: playoffStart || 'TBD', lastGames };
}

// Every player league-wide for a season, deduped by name (keep most games).
async function fetchLeague(season) {
  let all = [];
  try {
    for (let page = 1; page <= 4; page++) {
      const res = await axios.get('https://api.server.nbaapi.com/api/playertotals', { params: { season, isPlayoff: false, pageSize: 500, page }, timeout: 20000 });
      const data = res.data?.data || []; all = all.concat(data);
      if (data.length < 500) break;
    }
  } catch (err) { console.error('  league fetch failed:', err.message); }
  const m = new Map();
  for (const p of all) { const k = normalize(p.playerName), e = m.get(k); if (!e || parseInt(p.games || 0, 10) > parseInt(e.games || 0, 10)) m.set(k, p); }
  return [...m.values()];
}
const perGame = (p) => { const gp = parseInt(p.games || 1, 10) || 1; return {
  name: p.playerName, team: p.team, gp: parseInt(p.games || 0, 10),
  pts: parseFloat(p.points || 0) / gp, reb: parseFloat(p.totalRb || 0) / gp, ast: parseFloat(p.assists || 0) / gp,
  stl: parseFloat(p.steals || 0) / gp, blk: parseFloat(p.blocks || 0) / gp }; };

// Advanced stats league-wide (win shares, offensive/defensive WS, VORP, PER), deduped by name (most games).
async function fetchAdvanced(season) {
  let all = [];
  try {
    for (let page = 1; page <= 4; page++) {
      const res = await axios.get('https://api.server.nbaapi.com/api/playeradvancedstats', { params: { season, isPlayoff: false, pageSize: 500, page }, timeout: 20000 });
      const data = res.data?.data || []; all = all.concat(data);
      if (data.length < 500) break;
    }
  } catch (err) { console.error('  advanced fetch failed:', err.message); }
  const m = new Map();
  for (const p of all) { const k = normalize(p.playerName), e = m.get(k); if (!e || parseInt(p.games || 0, 10) > parseInt(e.games || 0, 10)) m.set(k, p); }
  return [...m.values()];
}

// Per-season awards. Voted NBA awards aren't in the data source, so these are derived from the stats:
//   MVP / Offensive POY / Defensive POY from win shares (overall / offensive / defensive),
//   plus the statistical leader in each box-score category. Without win shares yet, falls back to espnAwards().
function seasonAwards(season, totals, advanced, espn = []) {
  const totMap = {}; for (const p of totals) totMap[normalize(p.playerName)] = perGame(p);
  const maxG = advanced.reduce((m, p) => Math.max(m, parseInt(p.games || 0, 10)), 0);
  const minG = Math.max(10, Math.floor(maxG * 0.5));
  const adv = advanced.map(p => ({ name: p.playerName, team: p.team, gp: parseInt(p.games || 0, 10),
    ws: parseFloat(p.winShares || 0), ows: parseFloat(p.offensiveWS || 0), dws: parseFloat(p.defensiveWS || 0) })).filter(p => p.gp >= minG);
  const q = totals.map(perGame).filter(p => p.gp >= minG);
  if (!adv.length || !q.length) return espnAwards(espn);
  const byWs = adv.slice().sort((a, b) => b.ws - a.ws);
  const contenders = byWs.slice(0, 5).map((p, i) => { const t = totMap[normalize(p.name)];
    return { rank: i + 1, name: p.name, team: p.team, ppg: t ? t.pts.toFixed(1) : '—', rpg: t ? t.reb.toFixed(1) : '—', apg: t ? t.ast.toFixed(1) : '—' }; });
  const topAdv = (key) => adv.slice().sort((a, b) => b[key] - a[key])[0];
  const topPg = (key) => q.slice().sort((a, b) => b[key] - a[key])[0];
  const advAward = (label, key, unit) => { const p = topAdv(key); return { category: label, name: p.name, team: p.team, value: p[key].toFixed(1) + ' ' + unit }; };
  const pgAward = (label, key, unit) => { const p = topPg(key); return { category: label, name: p.name, team: p.team, value: p[key].toFixed(1) + ' ' + unit }; };
  const leaders = [
    advAward('MVP', 'ws', 'WS'),
    advAward('Offensive POY', 'ows', 'OWS'),
    advAward('Defensive POY', 'dws', 'DWS'),
    pgAward('Points', 'pts', 'PPG'), pgAward('Rebounds', 'reb', 'RPG'), pgAward('Assists', 'ast', 'APG'),
    pgAward('Steals', 'stl', 'SPG'), pgAward('Blocks', 'blk', 'BPG'),
  ];
  return { contenders, leaders };
}

// Early in a season nbaapi.com has no win shares yet: rank the MVP race by per-game efficiency (EFF) from ESPN,
// and give per-game leaders. No data at all -> empty lists (the page says so) rather than made-up names.
function espnAwards(espn) {
  const maxG = espn.reduce((m, p) => Math.max(m, p.gp), 0);
  const q = espn.filter(p => p.gp >= Math.max(1, Math.floor(maxG * 0.5)));
  if (!q.length) return { contenders: [], leaders: [] };
  const top = (key) => q.slice().sort((a, b) => b[key] - a[key])[0];
  const award = (label, key, unit) => { const p = top(key); return { category: label, name: p.name, team: p.team, value: p[key].toFixed(1) + ' ' + unit }; };
  const contenders = q.slice().sort((a, b) => b.eff - a.eff).slice(0, 5).map((p, i) =>
    ({ rank: i + 1, name: p.name, team: p.team, ppg: p.pts.toFixed(1), rpg: p.reb.toFixed(1), apg: p.ast.toFixed(1) }));
  return { contenders, leaders: [award('Efficiency', 'eff', 'EFF'), award('Points', 'pts', 'PPG'), award('Rebounds', 'reb', 'RPG'),
    award('Assists', 'ast', 'APG'), award('Steals', 'stl', 'SPG'), award('Blocks', 'blk', 'BPG')] };
}

const q = (text, params = {}) => { const r = db.request(); for (const [k, v] of Object.entries(params)) r.input(k, v); return r.query(text); };

async function upsertTeam(t) {
  await q(`UPDATE dbo.teams SET name=@name, logo=@logo, espn_id=@espn, nbaapi_abbr=@nba WHERE abbr=@abbr;
           IF @@ROWCOUNT = 0 INSERT dbo.teams(abbr, name, logo, espn_id, nbaapi_abbr) VALUES(@abbr, @name, @logo, @espn, @nba);`,
    { abbr: t.abbr, name: t.name, logo: t.logo, espn: parseInt(t.id, 10), nba: t.nbaapi });
}

async function syncTeamSeason(team, season, espnStats) {
  await q('UPDATE dbo.players SET updated_at = NULL WHERE season = @season AND team = @team', { season, team: team.abbr });
  let roster;
  try { roster = await getSeasonPlayers(team, season, espnStats); } catch (err) { console.error(`  ${team.abbr} ${season} roster failed: ${err.message}`); return 0; }
  if (!roster.length) return 0;  // keep whatever is there rather than wiping
  for (const p of roster) {
    await q(`UPDATE dbo.players SET num=@num, pos=@pos, espn_id=@espn, photo=@photo, ppg=@ppg, rpg=@rpg, apg=@apg, spg=@spg, bpg=@bpg,
             fgp=@fgp, tpp=@tpp, ftp=@ftp, gp=@gp, mpg=@mpg, injury=@injury, injury_detail=@detail, updated_at=GETDATE()
             WHERE season=@season AND team=@team AND name=@name;
             IF @@ROWCOUNT = 0 INSERT dbo.players(season, team, num, name, pos, ppg, rpg, apg, spg, bpg, fgp, tpp, ftp, gp, mpg, injury, injury_detail, espn_id, photo, updated_at)
             VALUES(@season, @team, @num, @name, @pos, @ppg, @rpg, @apg, @spg, @bpg, @fgp, @tpp, @ftp, @gp, @mpg, @injury, @detail, @espn, @photo, GETDATE());`,
      { season, team: team.abbr, num: p.num, name: p.name, pos: p.pos, espn: p.espnId, photo: p.photo || '', injury: p.injury, detail: p.injuryDetail,
        ppg: p.stats.ppg, rpg: p.stats.rpg, apg: p.stats.apg, spg: p.stats.spg, bpg: p.stats.bpg, fgp: p.stats.fgp, tpp: p.stats.tpp, ftp: p.stats.ftp, gp: p.stats.gp, mpg: p.stats.mpg });
  }
  await q('DELETE FROM dbo.players WHERE season=@season AND team=@team AND updated_at IS NULL', { season, team: team.abbr });
  try {
    const sc = await fetchSchedule(team.id, season);
    await q(`UPDATE dbo.schedule_info SET played=@played, remaining=@remaining, playoff_start=@ps, last_games=@lg, updated_at=GETDATE() WHERE season=@season AND team=@team;
             IF @@ROWCOUNT = 0 INSERT dbo.schedule_info(season, team, played, remaining, playoff_start, last_games, updated_at) VALUES(@season, @team, @played, @remaining, @ps, @lg, GETDATE());`,
      { season, team: team.abbr, played: sc.played, remaining: sc.remaining, ps: sc.playoffStart, lg: JSON.stringify(sc.lastGames) });
  } catch (err) { /* schedule is best-effort */ }
  return roster.length;
}

async function sync(seasons = SEASONS) {
  let teams;
  try { teams = await fetchTeams(); } catch (err) { console.error('team list fetch failed:', err.message); return; }
  console.log(`=== Sync @ ${new Date().toISOString()} | ${teams.length} teams x seasons [${seasons.join(', ')}] ===`);
  for (const t of teams) { try { await upsertTeam(t); } catch (err) { console.error(`  team ${t.abbr} meta failed: ${err.message}`); } }
  for (const season of seasons) {
    let players = 0, done = 0;
    const espn = season === currentSeasonEndYear() ? await fetchEspnStats(season) : { byId: {}, list: [] };
    if (season === currentSeasonEndYear()) console.log(`  ESPN stats for ${espn.list.length} players`);
    for (const t of teams) { players += await syncTeamSeason(t, season, espn.byId); done++; await sleep(120); }
    const { contenders, leaders } = seasonAwards(season, await fetchLeague(season), await fetchAdvanced(season), espn.list);
    await q('DELETE FROM dbo.mvp_contenders WHERE season = @season', { season });
    for (const m of contenders) await q('INSERT dbo.mvp_contenders(season, [rank], name, team, ppg, rpg, apg) VALUES(@season, @rank, @name, @team, @ppg, @rpg, @apg)', { season, ...m });
    await q('DELETE FROM dbo.leaders WHERE season = @season', { season });
    for (let i = 0; i < leaders.length; i++) await q('INSERT dbo.leaders(season, ord, category, name, team, value) VALUES(@season, @ord, @category, @name, @team, @value)', { season, ord: i, ...leaders[i] });
    console.log(`  season ${season} (${season - 1}-${String(season).slice(-2)}): ${done} teams, ${players} players, ${leaders.length} category leaders`);
  }
  console.log('=== Sync complete ===');
}

(async () => {
  console.log('NBA Hub feeder. Seasons:', SEASONS.join(', '));
  for (let i = 1; ; i++) {
    try { await db.connect(); console.log('Connected:', (await q('SELECT @@VERSION AS v')).recordset[0].v.split('\n')[0]); break; }
    catch (err) { console.error(`DB connect failed (${i}): ${err.message}`); await new Promise(r => setTimeout(r, Math.min(60, 5 * i) * 1000)); }
  }
  await sync();   // startup: every season in NBA_SEASONS, which backfills completed ones
  // Scheduled: the current season only (completed seasons don't change). Evaluated at each run, so it rolls over in October.
  cron.schedule(SYNC_CRON, () => sync([currentSeasonEndYear()]));
  console.log(`Scheduled: current season on "${SYNC_CRON}" (${process.env.TZ || 'UTC'})`);
})();
