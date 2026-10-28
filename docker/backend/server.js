const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD,   // from .env (see .env.example)
  database: process.env.DB_NAME || 'roster_db',
  port: 5432,
});

// ─── MASTER ROSTER ────────────────────────────────────────────────────────────
const masterRoster = [
  { num: "7",  name: "Jaylen Brown",       pos: "F/G", espnId: "3917376" },
  { num: "0",  name: "Jayson Tatum",       pos: "F",   espnId: "4065648" },
  { num: "9",  name: "Derrick White",      pos: "G",   espnId: "3062679" },
  { num: "11", name: "Payton Pritchard",   pos: "G",   espnId: "4066349" },
  { num: "30", name: "Sam Hauser",         pos: "F",   espnId: "4066421" },
  { num: "88", name: "Neemias Queta",      pos: "C",   espnId: "4432165" },
  { num: "55", name: "Baylor Scheierman",  pos: "G",   espnId: "4431741" },
  { num: "27", name: "Jordan Walsh",       pos: "F",   espnId: "4683777" },
  { num: "52", name: "Luka Garza",         pos: "C",   espnId: "4278060" },
  { num: "28", name: "Hugo González",      pos: "F",   espnId: "5105088" },
  { num: "13", name: "Ron Harper Jr.",     pos: "F",   espnId: "4432805" },
];

// Fallback stats for players not returned by the API (new signings, G-league callups, etc.)
// Update these manually when needed.
const fallbackStats = {
  "luka garza":   { ppg:"5.1", rpg:"3.8", apg:"0.6", spg:"0.2", bpg:"0.5", fgp:"54.0", tpp:"0.0", ftp:"80.0", gp:"22", mpg:"11.0" },
  "hugo gonzalez":{ ppg:"3.9", rpg:"3.4", apg:"0.6", spg:"0.5", bpg:"0.3", fgp:"41.0", tpp:"34.0",ftp:"72.0", gp:"47", mpg:"14.0" },
  "ron harper jr":{ ppg:"6.2", rpg:"3.8", apg:"0.9", spg:"0.6", bpg:"0.3", fgp:"50.0", tpp:"38.0",ftp:"76.0", gp:"38", mpg:"14.5" },
};

// ─── FIELD MAPPING ───────────────────────────────────────────────────────────
// /api/playertotals returns SEASON TOTALS, not per-game averages.
//
//   points       → total points scored all season   → divide by games → PPG
//   totalRb      → total rebounds all season         → divide by games → RPG
//   assists      → total assists all season           → divide by games → APG
//   steals       → total steals all season            → divide by games → SPG
//   blocks       → total blocks all season            → divide by games → BPG
//   minutesPg    → minutes per game (already averaged by the API)
//   fieldPercent → FG% as decimal  (0.477 = 47.7%)  → multiply by 100
//   threePercent → 3P% as decimal  (0.385 = 38.5%)  → multiply by 100
//   ftPercent    → FT% as decimal  (0.874 = 87.4%)  → multiply by 100
//   games        → integer count of games played
//
// BUG FIX: Previous code used points/totalRb/assists/steals/blocks directly,
// producing season totals in the per-game stat columns (e.g. "1842 PPG").
// These five fields must be divided by games to get true per-game averages.

function extractStats(p) {
  // /api/playertotals returns season cumulative totals for counting stats.
  // Divide by games to get per-game averages.
  // Percentage fields and minutesPg are already per-game/ratio — use directly.
  const gp  = parseInt(p.games || 1, 10) || 1; // guard against division by zero
  const avg = (v) => (parseFloat(v || 0) / gp).toFixed(1);
  const fmt = (v) => parseFloat(v || 0).toFixed(1);
  const pct = (v) => (parseFloat(v || 0) * 100).toFixed(1);

  return {
    ppg: avg(p.points),
    rpg: avg(p.totalRb),
    apg: avg(p.assists),
    spg: avg(p.steals),
    bpg: avg(p.blocks),
    mpg: fmt(p.minutesPg),   // already per-game
    fgp: pct(p.fieldPercent),
    tpp: pct(p.threePercent),
    ftp: pct(p.ftPercent),
    gp:  String(p.games || 0),
  };
}

// ─── FETCH STATS FROM nbaapi.com ─────────────────────────────────────────────
async function fetchNbaApiStats() {
  const statsMap = {};
  try {
    const res = await axios.get('https://api.server.nbaapi.com/api/playertotals', {
      params: { team: 'BOS', season: 2026, isPlayoff: false, pageSize: 50 },  // 2025-26 season (API uses end-year)
      timeout: 15000,
      headers: { 'Accept': 'application/json' },
    });

    const players = res.data?.data || [];
    console.log(`  nbaapi.com returned ${players.length} players`);

    for (const p of players) {
      const key = normalize(p.playerName);
      statsMap[key] = extractStats(p);
    }
  } catch (err) {
    console.error('  nbaapi.com fetch failed:', err.message);
  }
  return statsMap;
}

// ─── FETCH INJURY STATUS FROM ESPN /roster ────────────────────────────────────
async function fetchInjuryMap() {
  const injuryMap = {};
  try {
    const rosterRes = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/roster',
      { timeout: 10000, headers: { 'Accept': 'application/json' } }
    );

    const injured = (rosterRes.data?.athletes || []).filter(a => a.injuries?.length > 0);
    console.log(`  ESPN: ${injured.length} injured player(s) found on roster`);

    for (const athlete of injured) {
      const inj    = athlete.injuries[0];
      const status = inj.status; // e.g. "Out", "Day-To-Day", "Questionable"

      // ESPN's roster endpoint includes the injury reason directly on the injury object.
      // Try every known field name before falling back to the athlete API.
      let detail =
        inj.longComment   ||  // full sentence e.g. "Right knee soreness"
        inj.shortComment  ||  // abbreviated version
        inj.description   ||  // alternate field name used in some responses
        inj.type?.description || // injury type object
        null;

      // If the roster object had nothing, hit the dedicated athlete endpoint —
      // it exposes an `injuries` array with a `details.fantasyStatus.description`
      // or `details.type.description` field that is NOT present on /roster.
      if (!detail) {
        try {
          const athRes = await axios.get(
            `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/athletes/${athlete.id}`,
            { timeout: 8000, headers: { 'Accept': 'application/json' } }
          );
          const athInj = athRes.data?.athlete?.injuries?.[0];
          detail =
            athInj?.longComment        ||
            athInj?.shortComment       ||
            athInj?.description        ||
            athInj?.details?.type?.description ||
            null;
        } catch (_) { /* athlete fetch failed — store status only */ }
      }

      if (detail) {
        detail = detail.replace(/<[^>]+>/g, '').trim();
        if (detail.length > 200) detail = detail.slice(0, 197) + '...';
      }

      injuryMap[athlete.id] = { status, detail };
      console.log(`  ${athlete.displayName}: ${status}${detail ? ' — ' + detail : ' (no detail)'}`);
    }

    console.log(`  ESPN injury map built for ${Object.keys(injuryMap).length} player(s)`);
  } catch (err) {
    console.error('  ESPN injury fetch failed:', err.message);
  }
  return injuryMap;
}

// ─── MVP LADDER CONFIG ───────────────────────────────────────────────────────
// Source: NBA.com Kia MVP Ladder (published every Friday).
// Update this list manually each Friday when the new ladder drops.
// Order matters — index 0 = #1 on the ladder.
// Last updated: Week 23 (March 27, 2026)
const mvpLadder = [
  'Victor Wembanyama',
  'Shai Gilgeous-Alexander',
  'Nikola Jokic',
  'Luka Doncic',
  'Jaylen Brown',
];

// ─── FETCH MVP CONTENDERS ─────────────────────────────────────────────────────
// Uses mvpLadder for the correct ranked order, then fetches live stats
// from nbaapi.com to display up-to-date PPG/RPG/APG next to each name.
async function fetchMvpContenders() {
  try {
    // Fetch all player totals in one call (no team filter = league-wide)
    const res = await axios.get('https://api.server.nbaapi.com/api/playertotals', {
      params: { season: 2026, pageSize: 500, page: 1 },
      timeout: 15000,
      headers: { 'Accept': 'application/json' },
    });
    const allPlayers = res.data?.data || [];
    console.log(`  MVP: fetched ${allPlayers.length} players from nbaapi.com`);

    // Deduplicate traded players — keep the row with the most games
    const byName = new Map();
    for (const p of allPlayers) {
      const key = normalize(p.playerName);
      const existing = byName.get(key);
      if (!existing || parseInt(p.games || 0) > parseInt(existing.games || 0)) {
        byName.set(key, p);
      }
    }

    const results = [];
    for (let i = 0; i < mvpLadder.length; i++) {
      const ladderName  = mvpLadder[i];
      const key         = normalize(ladderName);
      const p           = byName.get(key);
      const gp          = parseInt(p?.games || 1, 10) || 1;

      const entry = {
        rank: i + 1,
        name: p?.playerName || ladderName,
        team: p?.team       || '—',
        ppg:  p ? (parseFloat(p.points  || 0) / gp).toFixed(1) : '—',
        rpg:  p ? (parseFloat(p.totalRb || 0) / gp).toFixed(1) : '—',
        apg:  p ? (parseFloat(p.assists || 0) / gp).toFixed(1) : '—',
      };
      results.push(entry);
      console.log(`  MVP #${entry.rank}: ${entry.name} (${entry.team}) — ${entry.ppg}pts ${entry.rpg}reb ${entry.apg}ast`);
    }
    return results;
  } catch (err) {
    console.error('  MVP fetch failed:', err.message);
    return [];
  }
}


// ─── NAME NORMALIZER ──────────────────────────────────────────────────────────
function normalize(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // é→e, ó→o, ü→u, etc.
    .replace(/[^a-z0-9 ]/g, '')      // strip Jr., apostrophes, periods
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── MAIN SYNC ────────────────────────────────────────────────────────────────
async function initializeAndSync() {
  console.log('=== Starting sync ===');
  try {
    for (const p of masterRoster) {
      await pool.query(
        `INSERT INTO players (num, name, pos, ppg, rpg, apg, espn_id)
         VALUES ($1,$2,$3,'0.0','0.0','0.0',$4)
         ON CONFLICT (name) DO UPDATE SET num=$1, pos=$3, espn_id=$4`,
        [p.num, p.name, p.pos, p.espnId]
      );
    }

    console.log('Fetching stats from nbaapi.com...');
    const statsMap = await fetchNbaApiStats();

    console.log('Fetching injuries from ESPN...');
    const injuryMap = await fetchInjuryMap();

    console.log('Updating database...');
    for (const p of masterRoster) {
      const key    = normalize(p.name);
      const injuryData = injuryMap[p.espnId] || null;
      const injury       = injuryData ? injuryData.status : null;
      const injuryDetail = injuryData ? injuryData.detail : null;

      // Use live API data if available, fall back to manual fallback stats
      const stats = statsMap[key] || fallbackStats[key];
      const source = statsMap[key] ? 'live' : (fallbackStats[key] ? 'fallback' : null);

      if (stats) {
        console.log(`  ✓ ${p.name} [${source}]: ${stats.ppg} PPG | ${stats.rpg} RPG | ${stats.apg} APG${injury ? ` | ⚠ ${injury}` : ''}`);
        await pool.query(
          `UPDATE players
           SET ppg=$1, rpg=$2, apg=$3, spg=$4, bpg=$5,
               fgp=$6, tpp=$7, ftp=$8, gp=$9, mpg=$10,
               injury=$11, injury_detail=$12
           WHERE name=$13`,
          [stats.ppg, stats.rpg, stats.apg, stats.spg, stats.bpg,
           stats.fgp, stats.tpp, stats.ftp, stats.gp, stats.mpg,
           injury, injuryDetail, p.name]
        );
      } else {
        console.log(`  ✗ ${p.name}: no data found (check name spelling or add to fallbackStats)`);
        if (injury) {
          await pool.query(`UPDATE players SET injury=$1, injury_detail=$2 WHERE name=$3`, [injury, injuryDetail, p.name]);
        }
      }
    }


    console.log('Fetching MVP contenders...');
    const mvpList = await fetchMvpContenders();
    if (mvpList.length) {
      await pool.query('DELETE FROM mvp_contenders');
      for (const p of mvpList) {
        await pool.query(
          `INSERT INTO mvp_contenders (rank, name, team, ppg, rpg, apg)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [p.rank, p.name, p.team, p.ppg, p.rpg, p.apg]
        );
      }
      console.log(`  MVP contenders saved: ${mvpList.map(p => p.name).join(', ')}`);
    }

    console.log('=== Sync complete ===');
  } catch (err) {
    console.error('Sync error:', err.message);
  }
}

// ─── DB CONNECT WITH RETRY ────────────────────────────────────────────────────
async function startApp() {
  for (let i = 5; i > 0; i--) {
    try {
      await pool.query('SELECT 1');
      console.log('Database connected.');
      await initializeAndSync();
      return;
    } catch {
      console.log(`DB not ready, retrying (${i - 1} left)...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.error('Could not connect to database after 5 attempts.');
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/api/roster', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM players ORDER BY CAST(num AS INT) ASC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual re-sync: curl -X POST http://localhost:3000/api/sync
app.post('/api/sync', async (req, res) => {
  res.json({ message: 'Sync started — watch server logs.' });
  initializeAndSync();
});

// Debug raw API response: curl http://localhost:3000/api/debug/nbaapi
app.get('/api/debug/nbaapi', async (req, res) => {
  try {
    const r = await axios.get('https://api.server.nbaapi.com/api/playertotals', {
      params: { team: 'BOS', season: 2026, isPlayoff: false, pageSize: 50 },  // 2025-26 season (API uses end-year)
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MVP contenders: curl http://localhost:3000/api/mvp
app.get('/api/mvp', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM mvp_contenders ORDER BY rank ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SCHEDULE ENDPOINT ────────────────────────────────────────────────────────
// Returns: { played, remaining, playoffStart, lastGames }
// lastGames: array of last 3 finished games { result:'W'|'L', score:'109-102', opp:'ATL' }
app.get('/api/schedule', async (req, res) => {
  try {
    const r = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/schedule',
      { params: { season: 2026 }, timeout: 10000, headers: { Accept: 'application/json' } }
    );

    const events = r.data?.events || [];
    const now    = Date.now();

    const finished = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    const upcoming = events.filter(e => !e.competitions?.[0]?.status?.type?.completed);

    // Last 3 completed games
    const lastGames = finished.slice(-3).map(e => {
      const comp       = e.competitions[0];
      const home       = comp.competitors.find(c => c.homeAway === 'home');
      const away       = comp.competitors.find(c => c.homeAway === 'away');
      const celtics    = comp.competitors.find(c => c.team?.abbreviation === 'BOS');
      const opponent   = comp.competitors.find(c => c.team?.abbreviation !== 'BOS');
      const cs = String(celtics?.score?.displayValue ?? celtics?.score ?? '0');
      const os = String(opponent?.score?.displayValue ?? opponent?.score ?? '0');
      const celticsWon = parseInt(cs) > parseInt(os);
      const score = `${cs}-${os}`;
      return {
        result: celticsWon ? 'W' : 'L',
        score,
        opp: opponent?.team?.abbreviation || '?',
        isHome: celtics?.homeAway === 'home',
      };
    });

    // Playoff start date — first event after regular season (look for a gap > 10 days)
    let playoffStart = null;
    for (let i = 0; i < upcoming.length - 1; i++) {
      const a = new Date(upcoming[i].date);
      const b = new Date(upcoming[i + 1].date);
      if ((b - a) > 10 * 24 * 60 * 60 * 1000) {
        playoffStart = b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
        break;
      }
    }

    res.json({
      played:       finished.length,
      remaining:    upcoming.length,
      playoffStart: playoffStart || 'TBD',
      lastGames,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START + CRON ─────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log('NBA Hub API running on port 3000');
  startApp();
});

cron.schedule('0 * * * *', () => {
  console.log('Hourly sync triggered.');
  initializeAndSync();
});