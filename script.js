(function () {
  'use strict';

  // ----------------------------- Estado --------------------------------------
  const STATE = {
    all: [],
    filtered: [],
    shown: 0,
    chunk: 100,
    main: 'Home',          // 'Home' | 'Guilds' | 'Players' | 'General'
    sub: '',               // 'Battles' | 'Month' | 'WinRate'
    view: 'HOME',          // 'HOME' | 'LIST'
    sortKey: 'KILLS',
    sortAsc: false,
    loader: null,          // AbortController
    io: null,              // IntersectionObserver
  };

  const SERVER_KB = { americas: 'live_us', asia: 'live_sgp', europe: 'live_ams' };

  // Nomes reais dos meses em PT para exibição
  const PT_MONTH = {
    january: 'January', february: 'February', march: 'March', april: 'April',
    may: 'May', june: 'June', july: 'July', august: 'August',
    september: 'September', october: 'October', november: 'November', december: 'December',
  };

  // Lista ordenada de todos os meses possíveis
  const ALL_MONTH_KEYS = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
  ];

  // Anos a verificar (atual e anteriores)
  const YEARS_TO_SCAN = [2024, 2025, 2026];

  // Cache dos meses disponíveis descobertos
  let AVAILABLE_MONTHS = []; // [{ key: 'january', year: 2026, label: 'Janeiro 2026', value: 'january|2026' }]

  /**
   * Verifica se um arquivo CSV existe tentando um HEAD request.
   * Retorna true se o servidor responder com 200/304.
   */
  async function probeFile(path) {
    try {
      const r = await fetch(path, { method: 'HEAD', cache: 'no-cache' });
      return r.ok;
    } catch { return false; }
  }

  // Cache key for persisting discovered months across page loads
  const MONTHS_CACHE_KEY = 'ao:available_months_v2';

  function monthsFromRaw(raw) {
    return raw.map(m => {
      const cap = m.key.charAt(0).toUpperCase() + m.key.slice(1);
      return {
        key: m.key,
        year: m.year,
        cap,
        label: `${PT_MONTH[m.key] || cap} ${m.year}`,
        value: `${m.key}|${m.year}`,
        hasBattle: !!m.hasBattle,
      };
    });
  }

  function saveCachedMonths(raw) {
    try { localStorage.setItem(MONTHS_CACHE_KEY, JSON.stringify({ t: Date.now(), v: raw })); }
    catch { /* quota: ignore */ }
  }

  function loadCachedMonths() {
    try {
      const raw = localStorage.getItem(MONTHS_CACHE_KEY);
      if (!raw) return null;
      const { t, v } = JSON.parse(raw);
      // Cache valid for 30 minutes
      if (Date.now() - t > 30 * 60 * 1000) return null;
      return v;
    } catch { return null; }
  }

  /**
   * Carrega AVAILABLE_MONTHS a partir de months.json (instantâneo),
   * ou do cache localStorage (instantâneo), ou faz HEAD probes em background.
   *
   * Retorna imediatamente com dados conhecidos e, se precisar de HEAD probes,
   * dispara-os em background e chama onUpdate() quando terminarem.
   */
  async function discoverAvailableMonths(onUpdate) {
    // 1. Tenta months.json primeiro (fetch rápido, sem HEAD probes)
    try {
      const res = await fetch('./months.json', { cache: 'no-cache' });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.months) && json.months.length > 0) {
          saveCachedMonths(json.months);
          return monthsFromRaw(json.months);
        }
      }
    } catch { /* segue para próximo fallback */ }

    // 2. Tenta cache do localStorage (retorno instantâneo)
    const cached = loadCachedMonths();
    if (cached && cached.length > 0) {
      // Agenda refresh de background sem bloquear
      setTimeout(() => runHeadProbes().then(found => {
        if (found.length > 0) {
          saveCachedMonths(found.map(m => ({ key: m.key, year: m.year, hasBattle: m.hasBattle })));
          if (typeof onUpdate === 'function') onUpdate(found);
        }
      }), 0);
      return monthsFromRaw(cached);
    }

    // 3. Fallback completo: HEAD probes (bloqueia, mas só na primeira vez sem months.json)
    console.warn('[AO Ranks] months.json não encontrado e sem cache — usando HEAD probes (primeira vez).');
    const found = await runHeadProbes();
    if (found.length > 0) {
      saveCachedMonths(found.map(m => ({ key: m.key, year: m.year, hasBattle: m.hasBattle })));
    }
    return found;
  }

  async function runHeadProbes() {
    const found = [];
    const probes = [];

    for (const year of YEARS_TO_SCAN) {
      for (const monthKey of ALL_MONTH_KEYS) {
        const cap = monthKey.charAt(0).toUpperCase() + monthKey.slice(1);
        const path = `./Guilds/Guilds Total/americasguildsbattlestotal/${cap}${year}.csv`;
        probes.push({ monthKey, year, cap, path });
      }
    }

    const results = await Promise.all(
      probes.map(async (p) => ({ ...p, exists: await probeFile(p.path) }))
    );

    const battleProbes = [];
    for (const year of YEARS_TO_SCAN) {
      for (const monthKey of ALL_MONTH_KEYS) {
        const cap = monthKey.charAt(0).toUpperCase() + monthKey.slice(1);
        const path = `./Battles/americasbattles/${monthKey}${year}.csv`;
        battleProbes.push({ monthKey, year, cap, path });
      }
    }
    const battleResults = await Promise.all(
      battleProbes.map(async (p) => ({ ...p, exists: await probeFile(p.path) }))
    );

    for (const r of results) {
      if (r.exists) {
        found.push({
          key: r.monthKey, year: r.year, cap: r.cap,
          label: `${PT_MONTH[r.monthKey] || r.cap} ${r.year}`,
          value: `${r.monthKey}|${r.year}`,
          hasBattle: false,
        });
      }
    }

    for (const r of battleResults) {
      if (r.exists) {
        const existing = found.find(f => f.key === r.monthKey && f.year === r.year);
        if (existing) {
          existing.hasBattle = true;
        } else {
          found.push({
            key: r.monthKey, year: r.year, cap: r.cap,
            label: `${PT_MONTH[r.monthKey] || r.cap} ${r.year}`,
            value: `${r.monthKey}|${r.year}`,
            hasBattle: true,
          });
        }
      }
    }

    return found;
  }

  /**
   * Inicializa AVAILABLE_MONTHS e popula o seletor de ano.
   * Anos são ordenados do mais recente para o mais antigo.
   */
  function buildYearSelect(available) {
    AVAILABLE_MONTHS = available;
    const $sel = $('#select-year');
    $sel.empty();

    const years = [...new Set(available.map(m => m.year))].sort((a, b) => b - a);
    if (years.length === 0) {
      $sel.append('<option value="">No data</option>');
      return;
    }
    for (const y of years) {
      $sel.append(`<option value="${y}">${y}</option>`);
    }
    // Seleciona o mais recente por padrão
    $sel.val(years[0]);
  }

  /**
   * Popula o seletor de mês filtrando pelo ano selecionado.
   * No modo Month: adiciona opção "All months" no topo.
   * Mantém seleção anterior se ainda existir.
   */
  function buildMonthSelectForYear(year, addAll) {
    const $sel = $('#select-month');
    const currentVal = $sel.val();
    $sel.empty();

    const isGeneral = STATE.main === 'General';
    const months = AVAILABLE_MONTHS.filter(m => m.year === year && (isGeneral ? m.hasBattle : true));

    if (months.length === 0) {
      $sel.append('<option value="">No data</option>');
      return;
    }

    if (addAll) {
      $sel.append(`<option value="all|${year}">All months</option>`);
    }

    for (const m of months) {
      $sel.append(`<option value="${m.value}">${PT_MONTH[m.key] || m.cap}</option>`);
    }

    // Mantém seleção se ainda válida
    const allVals = [addAll ? `all|${year}` : null, ...months.map(m => m.value)].filter(Boolean);
    if (currentVal && allVals.includes(currentVal)) {
      $sel.val(currentVal);
    } else {
      $sel.val(allVals[0]);
    }
  }

  /**
   * Extrai monthKey e year do valor do seletor.
   * Formatos: "january|2026" → mês específico
   *           "all|2026"     → todos os meses do ano
   */
  function parseMonthValue(val) {
    if (!val) return { monthKey: 'january', year: 2026, allMonths: false };
    const parts = val.split('|');
    const key = parts[0] || 'january';
    const year = parseInt(parts[1], 10) || 2026;
    return {
      monthKey: key,
      year,
      allMonths: key === 'all',
    };
  }

  // -------------------------- Cache de CSV -----------------------------------
  // Guarda dados já parseados em memória (Map) — evita re-parse a cada navegação.
  // sessionStorage é usado só como fallback entre reloads de página.
  const MEM_CACHE = new Map(); // path → { t, rows: string (CSV bruto comprimido) }
  const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

  const cacheGet = (key) => {
    // 1. Memória primeiro (mais rápido)
    const mem = MEM_CACHE.get(key);
    if (mem && Date.now() - mem.t < CACHE_TTL_MS) return mem.v;
    MEM_CACHE.delete(key);
    // 2. sessionStorage como fallback entre reloads
    try {
      const raw = sessionStorage.getItem('ao:' + key);
      if (!raw) return null;
      const { t, v } = JSON.parse(raw);
      if (Date.now() - t > CACHE_TTL_MS) { sessionStorage.removeItem('ao:' + key); return null; }
      MEM_CACHE.set(key, { t, v }); // promove para memória
      return v;
    } catch { return null; }
  };
  const cacheSet = (key, v) => {
    const entry = { t: Date.now(), v };
    MEM_CACHE.set(key, entry);
    try { sessionStorage.setItem('ao:' + key, JSON.stringify(entry)); } catch { /* quota: ignore */ }
  };

  async function fetchCSV(path, signal) {
    const cached = cacheGet(path);
    if (cached !== null) return cached;
    try {
      const r = await fetch(path, { signal });
      if (!r.ok) return null;
      const text = await r.text();
      cacheSet(path, text);
      return text;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return null;
    }
  }

  // ----------------------------- Parser CSV ----------------------------------
  // Fast path: sem aspas → split simples, sem .trim() por campo (feito só onde necessário)
  function parseCSVLine(text) {
    if (text.indexOf('"') === -1) return text.split(',');
    // Slow path: campos com aspas
    const fields = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { fields.push(cur); cur = ''; continue; }
      cur += c;
    }
    fields.push(cur);
    // Conserta IDs em notação científica quebrada (1,0011E+15)
    if (fields.length > 3 && /^\d$/.test(fields[2]) && /^\d+.*E\+\d+$/i.test(fields[3])) {
      fields.splice(2, 2, fields[2] + ',' + fields[3]);
    }
    return fields;
  }

  // toInt otimizado: evita String() + regex quando já é número
  function toInt(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v | 0;
    const s = v.trim ? v.trim() : String(v);
    if (s === '' || s === '-') return 0;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  }

  function detectServerFromPath(p) {
    p = (p || '').toLowerCase();
    if (p.includes('europe')) return 'europe';
    if (p.includes('asia')) return 'asia';
    return 'americas';
  }

  // ----------------------------- Acessores -----------------------------------
  function getValue(item, key) {
    if (key === 'RANK') return '#';
    if (key === 'SERVER') return (item._serverOrigin || 'americas').toUpperCase();
    if (!item || !item._localMap) return '-';
    const mapKey = key.replace(/\s+/g, '_').toUpperCase().trim();
    const idx = item._localMap[mapKey];
    return (idx !== undefined && idx !== -1 && item[idx] !== undefined) ? item[idx] : '-';
  }

  function getColumns() {
    const keys = [];
    if (STATE.main === 'General') {
      keys.push('BATTLE_ID', 'KILLS', 'FAME');
      return keys;
    }
    if (STATE.sub === 'WinRate') {
      keys.push('GUILD', 'WIN', 'LOSS', 'TOTAL', 'WINRATE');
      return keys;
    }
    if (STATE.sub === 'Battles') keys.push('TIME', 'BATTLE_ID');
    if (STATE.main === 'Guilds') keys.push('GUILD');
    else keys.push('PLAYER', 'GUILD');
    keys.push('KILLS', 'DEATHS', 'FAME');
    return keys;
  }

  // ----------------------------- Carregamento --------------------------------
  async function loadData() {
    // Cancela carregamento anterior
    if (STATE.loader) STATE.loader.abort();
    STATE.loader = new AbortController();
    const signal = STATE.loader.signal;

    const server = $('#select-server').val() || 'global';
    const monthVal = $('#select-month').val() || (AVAILABLE_MONTHS[0] ? AVAILABLE_MONTHS[0].value : 'january|2026');
    const { monthKey, year, allMonths } = parseMonthValue(monthVal);

    persistFilters(server, monthVal);

    if (STATE.view === 'HOME') {
      $('#global-filters-box').hide();
      $('#search-box-container').hide();
      renderHomeDashboard(server, monthKey, year, signal);
      return;
    }

    $('#global-filters-box').css('display', 'flex');
    $('#search-box-container').css('display', 'block');

    STATE.all = [];
    STATE.filtered = [];
    STATE.shown = 0;

    $('#table-wrapper').html(`
      <div class="data-table-container" id="scroll-box">
        <div class="load-progress-bar"><div class="load-progress-fill" id="load-progress-fill"></div></div>
        <table class="premium-table">
          <thead id="table-head"></thead>
          <tbody id="table-body"></tbody>
        </table>
        <div id="list-status" class="loader-container">
          <div class="spinner-premium"></div>
          <span id="loader-main-text">Loading records...</span>
          <span class="loader-files-label" id="loader-files-label"></span>
        </div>
      </div>
    `);

    const servers = (server === 'global') ? ['americas', 'europe', 'asia'] : [server];

    // All months disponíveis do ano (usado em "All months" e em Ranking Anual)
    const monthsForYear = AVAILABLE_MONTHS
      .filter(m => m.year === year)
      .map(m => m.cap + m.year);

    const isMultiMonth = allMonths;
    const months = isMultiMonth
      ? (monthsForYear.length ? monthsForYear : [monthKey.charAt(0).toUpperCase() + monthKey.slice(1) + year])
      : [monthKey.charAt(0).toUpperCase() + monthKey.slice(1) + year];

    const folder = (STATE.sub === 'Battles') ? 'Battles' : 'Total';
    const suffix = (STATE.sub === 'Battles') ? 'battles' : 'battlestotal';

    const paths = [];
    if (STATE.main === 'General') {
      // Batalhas Geral: ./Battles/{server}battles/{month}{Year}.csv  ← minúsculo
      const generalMonths = isMultiMonth
        ? AVAILABLE_MONTHS.filter(m => m.year === year && m.hasBattle).map(m => m.key + m.year)
        : [monthKey + year];
      for (const s of servers) {
        for (const m of generalMonths) {
          paths.push(`./Battles/${s}battles/${m}.csv`);
        }
      }
    } else if (STATE.sub === 'WinRate') {
      // Win Rate: ./Win Rate/Guilds/{server}/{Month}{Year}.csv
      for (const s of servers) {
        for (const m of months) {
          paths.push(`./Win Rate/Guilds/${s}/${m}.csv`);
        }
      }
    } else {
      for (const s of servers) {
        const sub = s + STATE.main.toLowerCase() + suffix;
        for (const m of months) {
          paths.push(`./${STATE.main}/${STATE.main} ${folder}/${sub}/${m}.csv`);
        }
      }
    }

    try {
      // ── Skeleton rows while fetching ──────────────────────────────────────
      const isGlobalSkel = (server === 'global');
      const skelCols = getColumns();
      const skelWidths = skelCols.map(k => {
        if (k === 'KILLS' || k === 'DEATHS' || k === 'FAME' || k === 'WIN' || k === 'LOSS' || k === 'TOTAL' || k === 'WINRATE') return 'sk-num';
        if (k === 'TIME' || k === 'BATTLE_ID') return 'sk-medium';
        return 'sk-long';
      });

      let skelHtml = '';
      for (let s = 0; s < 18; s++) {
        skelHtml += '<tr class="skeleton-row">';
        skelHtml += '<td><div class="skeleton-cell sk-short"></div></td>';
        if (isGlobalSkel) skelHtml += '<td><div class="skeleton-cell sk-short"></div></td>';
        skelCols.forEach((_k, ci) => {
          skelHtml += `<td><div class="skeleton-cell ${skelWidths[ci]}"></div></td>`;
        });
        skelHtml += '</tr>';
      }
      document.getElementById('table-body').innerHTML = skelHtml;

      // ── Fetch progressivo: processa cada arquivo assim que chega ─────────
      let loaded = 0;
      const total = paths.length;
      let headersRendered = false;
      const tempMap = Object.create(null);
      let totalLines = 0;

      const updateProgress = (pct) => {
        const fill = document.getElementById('load-progress-fill');
        if (fill) fill.style.width = pct + '%';
        const lbl = document.getElementById('loader-files-label');
        if (lbl) lbl.textContent = `${loaded} / ${total} file${total !== 1 ? 's' : ''} loaded`;
      };

      const processCSV = (data, path) => {
        if (!data) return;
        const origin = detectServerFromPath(path);
        // Dividir em linhas: evitar split('\n') em arquivos enormes com indexOf
        const lines = data.split('\n');
        if (lines.length <= 1) return;

        const localMap = { TIME: -1, BATTLE_ID: -1, PLAYER: -1, GUILD: -1, KILLS: -1, DEATHS: -1, FAME: -1, WIN: -1, LOSS: -1, TOTAL: -1, WINRATE: -1 };
        const headers = parseCSVLine(lines[0]);
        headers.forEach((col, idx) => {
          const u = col.toUpperCase().trim().replace(/\s+/g, '_');
          if (['TIME', 'TEMPO'].includes(u)) localMap.TIME = idx;
          if (['BATTLE_ID', 'ID', 'BATTLEID'].includes(u)) localMap.BATTLE_ID = idx;
          if (['PLAYER', 'JOGADOR'].includes(u)) localMap.PLAYER = idx;
          if (['GUILD', 'GUILDA'].includes(u)) localMap.GUILD = idx;
          if (['KILLS', 'ABATES'].includes(u)) localMap.KILLS = idx;
          if (['DEATHS', 'MORTES'].includes(u)) localMap.DEATHS = idx;
          if (['FAME', 'FAMA'].includes(u)) localMap.FAME = idx;
          if (['WIN', 'WINS', 'VITORIA', 'VITÓRIAS'].includes(u)) localMap.WIN = idx;
          if (['LOSS', 'LOSSES', 'DERROTA', 'DERROTAS'].includes(u)) localMap.LOSS = idx;
          if (['TOTAL'].includes(u)) localMap.TOTAL = idx;
          if (['WINRATE', 'WINRATE_(%)', 'WINRATE_%', 'WIN_RATE', 'WIN_RATE_(%)'].includes(u) || u.startsWith('WINRATE')) localMap.WINRATE = idx;
        });

        const iGuild = localMap.GUILD, iPlayer = localMap.PLAYER;
        const iKills = localMap.KILLS, iDeaths = localMap.DEATHS, iFame = localMap.FAME;
        const iTime = localMap.TIME, iBattle = localMap.BATTLE_ID;
        const iWin = localMap.WIN, iLoss = localMap.LOSS, iTotal = localMap.TOTAL, iWinrate = localMap.WINRATE;

        const isWinRate = STATE.sub === 'WinRate';
        const isBattles = STATE.sub === 'Battles' || STATE.main === 'General';
        const isPlayers = STATE.main === 'Players';
        const isGuilds  = STATE.main === 'Guilds';

        for (let i = 1, len = lines.length; i < len; i++) {
          const line = lines[i];
          if (!line || line.charCodeAt(0) === 13) continue;
          const cols = parseCSVLine(line);
          if (cols.length < 2) continue;
          totalLines++;

          if (isWinRate) {
            const rawName = iGuild !== -1 ? cols[iGuild] : '';
            const name = rawName ? rawName.trim() : '';
            if (!name || name === '0' || name === '-' || name === '0 - 0') continue;
            const id = name.toLowerCase() + '_' + origin;
            const existing = tempMap[id];
            if (!existing) {
              const row = [];
              row[iGuild]   = name;
              if (iWin    !== -1) row[iWin]    = toInt(cols[iWin]);
              if (iLoss   !== -1) row[iLoss]   = toInt(cols[iLoss]);
              if (iTotal  !== -1) row[iTotal]  = toInt(cols[iTotal]);
              if (iWinrate !== -1) row[iWinrate] = parseFloat(cols[iWinrate]) || 0;
              row._serverOrigin = origin;
              row._localMap = localMap;
              tempMap[id] = row;
            } else {
              if (iWin    !== -1) existing[iWin]    += toInt(cols[iWin]);
              if (iLoss   !== -1) existing[iLoss]   += toInt(cols[iLoss]);
              if (iTotal  !== -1) existing[iTotal]  += toInt(cols[iTotal]);
              if (iWin !== -1 && iTotal !== -1) {
                const t = existing[iTotal];
                existing[iWinrate] = t > 0 ? parseFloat(((existing[iWin] / t) * 100).toFixed(2)) : 0;
              }
            }
            continue;
          }

          const kills  = iKills  !== -1 ? toInt(cols[iKills])  : -1;
          const deaths = iDeaths !== -1 ? toInt(cols[iDeaths]) : -1;

          if (kills === 0 && deaths === 0) continue;
          if (kills !== -1 && deaths !== -1 && kills < 10 && deaths < 10) continue;

          if (isGuilds || isPlayers) {
            const g = iGuild !== -1 ? cols[iGuild] : '';
            if (!g || g.trim() === '' || g === '0' || g === '-') continue;
          }

          const row = [];
          if (iTime   !== -1) row[iTime]   = cols[iTime]   || '';
          if (iBattle !== -1) row[iBattle] = cols[iBattle] || '';
          if (iPlayer !== -1) row[iPlayer] = cols[iPlayer] || '';
          if (iGuild  !== -1) row[iGuild]  = cols[iGuild]  || '';
          if (iKills  !== -1) row[iKills]  = kills;
          if (iDeaths !== -1) row[iDeaths] = deaths;
          if (iFame   !== -1) row[iFame]   = toInt(cols[iFame]);
          row._serverOrigin = origin;
          row._localMap = localMap;

          if (isBattles) {
            STATE.all.push(row);
          } else {
            const rawName = isPlayers ? cols[iPlayer] : cols[iGuild];
            const name = rawName ? rawName.trim() : '';
            if (!name || name === '0') continue;
            const id = name.toLowerCase() + '_' + origin;
            const existing = tempMap[id];
            if (!existing) {
              tempMap[id] = row;
            } else {
              if (iKills  !== -1) existing[iKills]  += kills;
              if (iDeaths !== -1) existing[iDeaths] += deaths;
              if (iFame   !== -1) existing[iFame]   += row[iFame];
            }
          }
        }
      };

      // Dispara fetches em paralelo mas processa + renderiza cada um ao chegar
      await Promise.all(paths.map(async (p) => {
        const data = await fetchCSV(p, signal);
        if (signal.aborted) return;
        loaded++;
        updateProgress(Math.round((loaded / total) * 100));
        processCSV(data, p);

        // Renderiza headers na primeira chegada e mostra dados parciais imediatamente
        if (!headersRendered) {
          headersRendered = true;
          if (STATE.sub !== 'Battles' && STATE.main !== 'General') {
            STATE.all = Object.values(tempMap);
          }
          document.getElementById('table-body').innerHTML = '';
          renderHeaders();
          applyCurrentFilter();
        }
      }));

      if (signal.aborted) return;

      // Renderização final com todos os dados consolidados
      if (STATE.sub !== 'Battles' && STATE.main !== 'General') STATE.all = Object.values(tempMap);

      // Esconde progresso
      const fill = document.getElementById('load-progress-fill');
      if (fill) { fill.style.width = '100%'; setTimeout(() => { const bar = fill.closest('.load-progress-bar'); if (bar) bar.style.opacity = '0'; }, 300); }

      document.getElementById('table-body').innerHTML = '';
      STATE.shown = 0;

      renderHeaders();
      applyCurrentFilter();

      if (STATE.all.length === 0) {
        $('#list-status').html('<span class="empty-state">Nenhum registo encontrado para esta seleção.</span>');
      } else {
        $('#list-status').remove();
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      $('#list-status').html('<span class="empty-state">Failed to load data. Check your connection.</span>');
    }
  }

  // ------------------------------- Render ------------------------------------
  function renderHeaders() {
    const isGlobal = $('#select-server').val() === 'global';
    const arrow = (k) => k === STATE.sortKey ? (STATE.sortAsc ? ' ↑' : ' ↓') : '';

    let h = `<tr><th class="sortable-th col-rank" data-key="RANK">Rank</th>`;
    if (isGlobal) h += `<th class="col-server" data-key="SERVER">Server</th>`;

    if (STATE.main === 'General') {
      h += `<th class="sortable-th col-battleid" data-key="BATTLE_ID">Battle ID${arrow('BATTLE_ID')}</th>`;
      h += `<th class="sortable-th col-num" data-key="KILLS">Kills${arrow('KILLS')}</th>`;
      h += `<th class="sortable-th col-num" data-key="FAME">Fame${arrow('FAME')}</th></tr>`;
    } else if (STATE.sub === 'WinRate') {
      h += `<th class="sortable-th col-name" data-key="GUILD">Guild${arrow('GUILD')}</th>`;
      h += `<th class="sortable-th col-num" data-key="WIN">Wins${arrow('WIN')}</th>`;
      h += `<th class="sortable-th col-num" data-key="LOSS">Losses${arrow('LOSS')}</th>`;
      h += `<th class="sortable-th col-num" data-key="TOTAL">Total${arrow('TOTAL')}</th>`;
      h += `<th class="sortable-th col-winrate" data-key="WINRATE">Win Rate${arrow('WINRATE')}</th></tr>`;
    } else {
      if (STATE.sub === 'Battles') {
        h += `<th class="sortable-th col-time" data-key="TIME">Time${arrow('TIME')}</th>`;
        h += `<th class="sortable-th col-battleid" data-key="BATTLE_ID">Battle ID${arrow('BATTLE_ID')}</th>`;
      }
      if (STATE.main === 'Guilds') {
        h += `<th class="sortable-th col-name" data-key="GUILD">Guild${arrow('GUILD')}</th>`;
      } else {
        h += `<th class="sortable-th col-name" data-key="PLAYER">Player${arrow('PLAYER')}</th>`;
        h += `<th class="sortable-th col-name" data-key="GUILD">Guild${arrow('GUILD')}</th>`;
      }
      h += `<th class="sortable-th col-num" data-key="KILLS">Kills${arrow('KILLS')}</th>`;
      h += `<th class="sortable-th col-num" data-key="DEATHS">Deaths${arrow('DEATHS')}</th>`;
      h += `<th class="sortable-th col-num" data-key="FAME">Fame${arrow('FAME')}</th></tr>`;
    }

    $('#table-head').html(h);
    bindHeaderSort();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function highlight(text, query) {
    const safe = escapeHtml(text);
    if (!query) return safe;
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp('(' + q + ')', 'ig'), '<mark>$1</mark>');
  }

  function renderTargetRows() {
    const tbody = document.getElementById('table-body');
    if (!tbody) return;
    const isGlobal = $('#select-server').val() === 'global';
    const limit = Math.min(STATE.shown + STATE.chunk, STATE.filtered.length);
    if (STATE.shown >= limit) return;

    const keys = getColumns();
    const q = ($('#search-input').val() || '').toLowerCase().trim();
    const frag = document.createDocumentFragment();

    for (let i = STATE.shown; i < limit; i++) {
      const item = STATE.filtered[i];
      const tr = document.createElement('tr');
      let html = `<td class="cell-rank">#${i + 1}</td>`;
      if (isGlobal) html += `<td class="cell-server"><span class="server-badge">${(item._serverOrigin || 'americas').toUpperCase()}</span></td>`;

      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        const val = getValue(item, k);

        if (k === 'WINRATE') {
          const n = parseFloat(val) || 0;
          const pct = n.toFixed(1);
          const color = n >= 60 ? 'var(--accent-green)' : n >= 45 ? 'var(--accent-gold)' : 'var(--accent-red)';
          html += `<td class="col-winrate tabular-nums" style="text-align:right;padding-right:24px;">
            <span style="color:${color};font-weight:700;">${pct}%</span>
            <div style="width:72px;height:4px;background:#1a2438;border-radius:2px;margin-top:4px;display:inline-block;vertical-align:middle;margin-left:8px;overflow:hidden;">
              <div style="width:${Math.min(n,100)}%;height:100%;background:${color};border-radius:2px;"></div>
            </div>
          </td>`;
        } else if (k === 'WIN') {
          const n = Number(val) || 0;
          html += `<td class="col-num tabular-nums" style="color:var(--accent-green);font-weight:600;text-align:right;padding-right:24px;">${n.toLocaleString('en-US')}</td>`;
        } else if (k === 'LOSS') {
          const n = Number(val) || 0;
          html += `<td class="col-num tabular-nums" style="color:var(--accent-red);font-weight:500;text-align:right;padding-right:24px;">${n.toLocaleString('en-US')}</td>`;
        } else if (k === 'TOTAL') {
          const n = Number(val) || 0;
          html += `<td class="col-num tabular-nums" style="text-align:right;padding-right:24px;">${n.toLocaleString('en-US')}</td>`;
        } else if (k === 'KILLS' || k === 'DEATHS' || k === 'FAME') {
          const n = Number(val) || 0;
          const cls = k === 'KILLS' ? 'cell-kills' : k === 'DEATHS' ? 'cell-deaths' : 'cell-fame';
          html += `<td class="${cls} col-num tabular-nums">${n.toLocaleString('en-US')}</td>`;
        } else if (k === 'BATTLE_ID') {
          const srv = SERVER_KB[item._serverOrigin] || 'live_us';
          const kbPath = (STATE.main === 'General' || STATE.main === 'Guilds') ? 'battles' : 'kill';
          const idClean = String(val).trim();
          const url = `https://albiononline.com/killboard/${kbPath}/${encodeURIComponent(idClean)}?server=${srv}`;
          html += `<td class="col-battleid"><a href="${url}" target="_blank" rel="noopener noreferrer" class="battle-id-link">${escapeHtml(val)}</a></td>`;
        } else if (k === 'PLAYER' || k === 'GUILD') {
          html += `<td class="col-name"><span class="clickable-name" data-name="${escapeHtml(val)}">${highlight(val, q)}</span></td>`;
        } else if (k === 'TIME') {
          html += `<td class="col-time">${escapeHtml(val)}</td>`;
        } else {
          html += `<td>${escapeHtml(val)}</td>`;
        }
      }
      tr.innerHTML = html;
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    STATE.shown = limit;
    setupSentinel();
  }

  function applyCurrentFilter() {
    const q = ($('#search-input').val() || '').toLowerCase().trim();
    $('#clear-search').toggle(q.length > 0);

    if (!q) {
      STATE.filtered = STATE.all; // referência direta — evita cópia O(n)
    } else {
      const isPlayers = (STATE.main === 'Players');
      const isGeneral = (STATE.main === 'General');
      const isWinRate = (STATE.sub === 'WinRate');
      STATE.filtered = STATE.all.filter((item) => {
        if (!item || !item._localMap) return false;
        if (isGeneral) {
          const bIdx = item._localMap.BATTLE_ID;
          const bId = (bIdx !== -1 && item[bIdx]) ? String(item[bIdx]).toLowerCase() : '';
          return bId.includes(q);
        }
        const gIdx = item._localMap.GUILD;
        const gName = (gIdx !== -1 && item[gIdx]) ? String(item[gIdx]).toLowerCase() : '';
        if (isWinRate) return gName.includes(q);
        if (isPlayers) {
          const pIdx = item._localMap.PLAYER;
          const pName = (pIdx !== -1 && item[pIdx]) ? String(item[pIdx]).toLowerCase() : '';
          return pName.includes(q) || gName.includes(q);
        }
        return gName.includes(q);
      });
    }

    STATE.shown = 0;
    $('#table-body').empty();
    sortBy(STATE.sortKey, STATE.sortAsc);
    renderHeaders();
    renderTargetRows();
    $('#total-rows').text(STATE.filtered.length.toLocaleString('en-US'));

    if (STATE.all.length > 0 && STATE.filtered.length === 0) {
      $('#table-body').html(`<tr><td colspan="10" class="empty-state">Nenhum resultado para “${escapeHtml(q)}”.</td></tr>`);
    }
  }

  function sortBy(key, asc) {
    const isNum = ['KILLS', 'DEATHS', 'FAME', 'WIN', 'LOSS', 'TOTAL', 'WINRATE'].includes(key);
    // Schwartzian transform: extrai valor uma vez por item em vez de a cada comparação
    const arr = STATE.filtered;
    const len = arr.length;
    const keyed = new Array(len);
    for (let i = 0; i < len; i++) {
      const v = getValue(arr[i], key);
      keyed[i] = { i, k: isNum ? Number(v) : String(v).toLowerCase() };
    }
    if (isNum) {
      keyed.sort(asc ? (a, b) => a.k - b.k : (a, b) => b.k - a.k);
    } else {
      keyed.sort(asc
        ? (a, b) => (a.k > b.k ? 1 : a.k < b.k ? -1 : 0)
        : (a, b) => (a.k < b.k ? 1 : a.k > b.k ? -1 : 0));
    }
    const sorted = new Array(len);
    for (let i = 0; i < len; i++) sorted[i] = arr[keyed[i].i];
    STATE.filtered = sorted;
  }

  function bindHeaderSort() {
    $('.sortable-th').off('click').on('click', function () {
      const key = $(this).attr('data-key');
      if (key === 'RANK') return;
      if (STATE.sortKey === key) STATE.sortAsc = !STATE.sortAsc;
      else { STATE.sortKey = key; STATE.sortAsc = false; }
      sortBy(STATE.sortKey, STATE.sortAsc);
      STATE.shown = 0;
      $('#table-body').empty();
      renderHeaders();
      renderTargetRows();
    });
  }

  // -------- Scroll infinito via IntersectionObserver -------------------------
  function setupSentinel() {
    if (STATE.io) { STATE.io.disconnect(); STATE.io = null; }
    if (STATE.shown >= STATE.filtered.length) return;
    const scrollBox = document.getElementById('scroll-box');
    const tbody = document.getElementById('table-body');
    if (!scrollBox || !tbody) return;

    let sentinel = document.getElementById('infinite-sentinel');
    if (sentinel) sentinel.remove();
    sentinel = document.createElement('tr');
    sentinel.id = 'infinite-sentinel';
    sentinel.innerHTML = '<td colspan="10" style="height:1px;padding:0;"></td>';
    tbody.appendChild(sentinel);

    STATE.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && STATE.shown < STATE.filtered.length) {
          renderTargetRows();
        }
      }
    }, { root: scrollBox, rootMargin: '200px' });
    STATE.io.observe(sentinel);
  }

  // -------------------------- Home Dashboard ---------------------------------
  async function renderHomeDashboard(server, month, year, signal) {
    $('#table-wrapper').html(`
      <div class="loader-container">
        <div class="spinner-premium"></div>
        <span>Loading consolidated database...</span>
      </div>
    `);

    // Carrega TODOS os meses disponíveis do ano para o gráfico comparativo
    const allServers = ['americas', 'europe', 'asia'];
    const monthsForYear = AVAILABLE_MONTHS.filter(m => m.year === year);
    const displayServers = (server === 'global') ? allServers : [server];

    function parseList(csvText, kind) {
      const out = [];
      if (!csvText) return out;
      const lines = csvText.split('\n');
      if (lines.length <= 1) return out;
      const map = { NAME: -1, GUILD: -1, KILLS: -1, DEATHS: -1, FAME: -1 };
      const headers = parseCSVLine(lines[0]);
      headers.forEach((h, idx) => {
        const u = h.toUpperCase().trim();
        if (kind === 'guild' && ['GUILD', 'GUILDA', 'NAME', 'NOME'].includes(u)) map.NAME = idx;
        if (kind === 'player' && ['PLAYER', 'JOGADOR', 'NAME', 'NOME'].includes(u)) map.NAME = idx;
        if (['GUILD', 'GUILDA'].includes(u) && kind === 'player') map.GUILD = idx;
        if (['KILLS', 'ABATES'].includes(u)) map.KILLS = idx;
        if (['DEATHS', 'MORTES'].includes(u)) map.DEATHS = idx;
        if (['FAME', 'FAMA'].includes(u)) map.FAME = idx;
      });
      if (map.NAME === -1) map.NAME = 0;
      if (map.KILLS === -1) map.KILLS = kind === 'player' ? 2 : 1;

      for (let i = 1; i < lines.length; i++) {
        const c = parseCSVLine(lines[i]);
        if (!c.length) continue;
        const name = (c[map.NAME] || '').trim();
        if (!name || name === '0' || name === '-') continue;
        const guild = map.GUILD !== -1 ? (c[map.GUILD] || '').trim() : '';
        // Exclui players sem guilda do ranking da Home
        if (kind === 'player' && (!guild || guild === '0' || guild === '-')) continue;
        out.push({
          name,
          guild: guild || '',
          kills: toInt(c[map.KILLS]),
          deaths: map.DEATHS !== -1 ? toInt(c[map.DEATHS]) : 0,
          fame: map.FAME !== -1 ? toInt(c[map.FAME]) : 0,
        });
      }
      return out;
    }

    try {
      // Monta paths de todos os meses para guildas e players (todos os 3 servidores para o gráfico)
      const allGuildPaths = [];
      const allPlayerPaths = [];
      for (const s of allServers) {
        for (const m of monthsForYear) {
          allGuildPaths.push({ path: `./Guilds/Guilds Total/${s}guildsbattlestotal/${m.cap}${year}.csv`, server: s, month: m.key });
          allPlayerPaths.push({ path: `./Players/Players Total/${s}playersbattlestotal/${m.cap}${year}.csv`, server: s, month: m.key });
        }
      }

      const fetchAll = [...allGuildPaths, ...allPlayerPaths].map(({ path, server: s, month: mk }) =>
        fetchCSV(path, signal).then((t) => ({
          kind: allGuildPaths.find(x => x.path === path) ? 'guild' : 'player',
          text: t, path, server: s, month: mk
        }))
      );

      const allResults = await Promise.all(fetchAll);
      if (signal && signal.aborted) return;

      // Agrega por servidor (todos os meses somados) para o gráfico
      const serverStats = {
        americas: { kills: 0, deaths: 0, fame: 0 },
        europe:   { kills: 0, deaths: 0, fame: 0 },
        asia:     { kills: 0, deaths: 0, fame: 0 },
      };
      // Agrega por mês+servidor para o gráfico de linha temporal
      const monthlyStats = {}; // { 'january': { americas: kills, europe: kills, asia: kills } }
      for (const m of monthsForYear) {
        monthlyStats[m.key] = { americas: 0, europe: 0, asia: 0 };
      }

      // Para leaderboards: apenas mes selecionado e servidores filtrados
      const guildAgg    = Object.create(null);
      const playerAgg   = Object.create(null);
      // Leaderboard global: TODOS os meses do ano + servidores filtrados
      const guildAggAll  = Object.create(null);
      const playerAggAll = Object.create(null);

      for (const r of allResults) {
        if (!r.text) continue;
        const rows = parseList(r.text, r.kind);
        const srv = r.server;

        // Acumula stats por servidor (todos os meses)
        if (r.kind === 'guild') {
          const killsSum  = rows.reduce((a, x) => a + x.kills, 0);
          const deathsSum = rows.reduce((a, x) => a + x.deaths, 0);
          const fameSum   = rows.reduce((a, x) => a + x.fame, 0);
          serverStats[srv].kills  += killsSum;
          serverStats[srv].deaths += deathsSum;
          serverStats[srv].fame   += fameSum;
          if (monthlyStats[r.month]) {
            monthlyStats[r.month][srv] += killsSum;
          }
        }

        // Leaderboard mensal: mes selecionado + servidores exibidos
        if (r.month === month && displayServers.includes(srv)) {
          const target = r.kind === 'guild' ? guildAgg : playerAgg;
          for (const row of rows) {
            const id = row.name.toLowerCase() + '_' + srv;
            if (!target[id]) {
              target[id] = { ...row, origin: srv };
            } else {
              target[id].kills  += row.kills;
              target[id].deaths += row.deaths;
              target[id].fame   += row.fame;
            }
          }
        }

        // Leaderboard global anual: todos os meses + servidores exibidos
        if (displayServers.includes(srv)) {
          const targetAll = r.kind === 'guild' ? guildAggAll : playerAggAll;
          for (const row of rows) {
            const id = row.name.toLowerCase() + '_' + srv;
            if (!targetAll[id]) {
              targetAll[id] = { ...row, origin: srv };
            } else {
              targetAll[id].kills  += row.kills;
              targetAll[id].deaths += row.deaths;
              targetAll[id].fame   += row.fame;
            }
          }
        }
      }

      // ── Sorted arrays — monthly ──────────────────────────────────────────────
      const topGuilds        = Object.values(guildAgg).sort((a, b) => b.kills   - a.kills);
      const topPlayers       = Object.values(playerAgg).sort((a, b) => b.kills  - a.kills);
      const topGuildsFame    = Object.values(guildAgg).sort((a, b) => b.fame    - a.fame);
      const topPlayersFame   = Object.values(playerAgg).sort((a, b) => b.fame   - a.fame);
      const topGuildsDeaths  = Object.values(guildAgg).sort((a, b) => b.deaths  - a.deaths);
      const topPlayersDeaths = Object.values(playerAgg).sort((a, b) => b.deaths - a.deaths);

      // ── Sorted arrays — all months (global annual) ───────────────────────────
      const allTopGuilds        = Object.values(guildAggAll).sort((a, b) => b.kills   - a.kills);
      const allTopPlayers       = Object.values(playerAggAll).sort((a, b) => b.kills  - a.kills);
      const allTopGuildsFame    = Object.values(guildAggAll).sort((a, b) => b.fame    - a.fame);
      const allTopPlayersFame   = Object.values(playerAggAll).sort((a, b) => b.fame   - a.fame);
      const allTopGuildsDeaths  = Object.values(guildAggAll).sort((a, b) => b.deaths  - a.deaths);
      const allTopPlayersDeaths = Object.values(playerAggAll).sort((a, b) => b.deaths - a.deaths);

      const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
      const totalKills  = displayServers.reduce((a, s) => a + serverStats[s].kills, 0);
      const totalFame   = displayServers.reduce((a, s) => a + serverStats[s].fame,  0);
      const totalGuilds = topGuilds.length;
      const totalPlayers = topPlayers.length;

      const badge = (i) => i === 0 ? 'badge-gold' : i === 1 ? 'badge-silver' : i === 2 ? 'badge-bronze' : 'badge-normal';
      const fmt = (n) => Number(n || 0).toLocaleString('en-US');

      // ── Helper: renders a top-10 leaderboard panel ──────────────────────────
      function renderTop10Panel(title, icon, items, valueKey, colorClass, maxVal, fillClass) {
        const top10 = items.slice(0, 10);
        if (!top10.length) return `
          <div class="lb-panel">
            <div class="panel-header"><h3>${icon} ${title}</h3><span class="tag-live-total">TOP 10</span></div>
            <p style="color:var(--text-secondary);font-size:12px;padding:16px 0;">No data.</p>
          </div>`;
        const rows = top10.map((item, i) => {
          const val = item[valueKey] || 0;
          const pct = maxVal > 0 ? Math.round((val / maxVal) * 100) : 0;
          let sub;
          if (valueKey === 'kills')  sub = `<span style="color:var(--accent-red);font-size:10px;">${fmt(item.deaths)} deaths</span>`;
          else if (valueKey === 'deaths') sub = `<span style="color:var(--accent-green);font-size:10px;">${fmt(item.kills)} kills</span>`;
          else sub = `<span style="color:var(--accent-green);font-size:10px;">${fmt(item.kills)} kills</span>`;
          const nameLine = item.guild && item.guild !== item.name
            ? `<span class="entity-sub" style="color:var(--text-secondary);font-size:10px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.guild)}</span>`
            : '';
          const serverTag = item.origin ? `<span class="server-badge" style="margin-left:4px;vertical-align:middle;">${item.origin.toUpperCase().slice(0,3)}</span>` : '';
          return `
            <div class="panel-row">
              <div class="row-main-meta">
                <div class="row-position ${badge(i)}">${i + 1}</div>
                <div class="row-details">
                  <span class="entity-name">${escapeHtml(item.name)}${serverTag}</span>
                  ${nameLine}
                  <div class="progress-bar-container">
                    <div class="progress-fill ${fillClass}" style="width:${pct}%"></div>
                  </div>
                </div>
              </div>
              <div class="row-stat">
                <span class="${colorClass}">${fmt(val)}</span>
                <div style="font-size:10px;color:var(--text-secondary);text-align:right;margin-top:2px;">${sub}</div>
              </div>
            </div>`;
        }).join('');
        return `
          <div class="lb-panel">
            <div class="panel-header"><h3>${icon} ${title}</h3><span class="tag-live-total">TOP 10</span></div>
            <div class="panel-list">${rows}</div>
          </div>`;
      }

      // ── Monthly maxima ───────────────────────────────────────────────────────
      const maxGuildKills   = topGuilds[0]        ? topGuilds[0].kills        : 1;
      const maxPlayerKills  = topPlayers[0]       ? topPlayers[0].kills       : 1;
      const maxGuildFame    = topGuildsFame[0]     ? topGuildsFame[0].fame     : 1;
      const maxPlayerFame   = topPlayersFame[0]   ? topPlayersFame[0].fame    : 1;
      const maxGuildDeaths  = topGuildsDeaths[0]  ? topGuildsDeaths[0].deaths  : 1;
      const maxPlayerDeaths = topPlayersDeaths[0] ? topPlayersDeaths[0].deaths : 1;

      // ── All-months maxima ────────────────────────────────────────────────────
      const allMaxGuildKills   = allTopGuilds[0]        ? allTopGuilds[0].kills        : 1;
      const allMaxPlayerKills  = allTopPlayers[0]       ? allTopPlayers[0].kills       : 1;
      const allMaxGuildFame    = allTopGuildsFame[0]    ? allTopGuildsFame[0].fame     : 1;
      const allMaxPlayerFame   = allTopPlayersFame[0]  ? allTopPlayersFame[0].fame    : 1;
      const allMaxGuildDeaths  = allTopGuildsDeaths[0] ? allTopGuildsDeaths[0].deaths  : 1;
      const allMaxPlayerDeaths = allTopPlayersDeaths[0]? allTopPlayersDeaths[0].deaths : 1;

      const monthLabel = PT_MONTH[month] || month;
      const yearLabel  = String(year);

      const leaderboardsHtml = `
        <div class="top10-section">
          <div class="top10-header">
            <h2>🌐 Global Top 10 — All of ${yearLabel}</h2>
            <span style="font-size:12px;color:var(--text-secondary);">All months combined · all servers combined</span>
          </div>
          <div class="top10-row-label">⚔️ Guilds</div>
          <div class="top10-guilds-row">
            ${renderTop10Panel('Guilds · Kills',   '⚔️',  allTopGuilds,        'kills',  'value-kills', allMaxGuildKills,   'fill-guild')}
            ${renderTop10Panel('Guilds · Deaths',  '💀',  allTopGuildsDeaths,  'deaths', 'cell-deaths', allMaxGuildDeaths,  'fill-guild')}
            ${renderTop10Panel('Guilds · Fame',    '🏆',  allTopGuildsFame,    'fame',   'cell-fame',   allMaxGuildFame,    'fill-guild')}
          </div>
          <div class="top10-row-label">🔺 Players</div>
          <div class="top10-players-row">
            ${renderTop10Panel('Players · Kills',  '🔺',  allTopPlayers,       'kills',  'value-kills', allMaxPlayerKills,  'fill-player')}
            ${renderTop10Panel('Players · Deaths', '☠️',  allTopPlayersDeaths, 'deaths', 'cell-deaths', allMaxPlayerDeaths, 'fill-player')}
            ${renderTop10Panel('Players · Fame',   '👑',  allTopPlayersFame,   'fame',   'cell-fame',   allMaxPlayerFame,   'fill-player')}
          </div>
        </div>`;

      // Dados do gráfico: meses no eixo X, kills por servidor
      const chartMonths = monthsForYear.map(m => PT_MONTH[m.key] || m.cap);
      const chartAmericas = monthsForYear.map(m => monthlyStats[m.key]?.americas || 0);
      const chartEurope   = monthsForYear.map(m => monthlyStats[m.key]?.europe   || 0);
      const chartAsia     = monthsForYear.map(m => monthlyStats[m.key]?.asia     || 0);

      // Barras de comparação de servidores (totais do ano)
      const maxServerKills = Math.max(serverStats.americas.kills, serverStats.europe.kills, serverStats.asia.kills, 1);
      const serverBarHtml = allServers.map(s => {
        const pct = Math.round((serverStats[s].kills / maxServerKills) * 100);
        const color = s === 'americas' ? '#f0a500' : s === 'europe' ? '#4e9af1' : '#e05c5c';
        const label = s === 'americas' ? 'Americas' : s === 'europe' ? 'Europe' : 'Asia';
        return `
          <div class="server-bar-row">
            <span class="server-bar-label">${label}</span>
            <div class="server-bar-track">
              <div class="server-bar-fill" style="width:${pct}%;background:${color};"></div>
            </div>
            <span class="server-bar-value">${fmt(serverStats[s].kills)}</span>
          </div>`;
      }).join('');

      const chartId = 'home-chart-' + Date.now();

      const html = `
        ${leaderboardsHtml}

        <style>
          /* ── Top 10 Global Section ───────────────────────────────────── */
          .top10-section {
            margin-top: 0;
          }
          .top10-header {
            display: flex;
            align-items: baseline;
            gap: 14px;
            margin-bottom: 20px;
          }
          .top10-header h2 {
            font-size: 16px;
            font-weight: 800;
            color: #ffffff;
          }
          .top10-guilds-row,
          .top10-players-row {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 20px;
          }
          .top10-row-label {
            font-size: 10px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #475569;
            margin-bottom: 10px;
          }
          .lb-panel {
            background-color: var(--bg-sidebar);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px;
          }
          .lb-panel .panel-header {
            margin-bottom: 16px;
          }
          .lb-panel .panel-header h3 {
            font-size: 13px;
            font-weight: 700;
          }
          .lb-panel .panel-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .lb-panel .panel-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 9px 12px;
            border-radius: 8px;
            background: rgba(255,255,255,0.01);
            border: 1px solid #172033;
            gap: 10px;
          }
          .lb-panel .row-main-meta {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 1;
            min-width: 0;
          }
          .lb-panel .row-position {
            width: 24px;
            height: 24px;
            font-size: 10px;
            flex-shrink: 0;
          }
          .lb-panel .row-details {
            flex: 1;
            min-width: 0;
            margin-right: 8px;
          }
          .lb-panel .entity-name {
            font-size: 12.5px;
            font-weight: 700;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            display: block;
          }
          .lb-panel .row-stat {
            text-align: right;
            flex-shrink: 0;
            font-size: 12.5px;
            font-variant-numeric: tabular-nums;
          }
          .lb-panel .progress-bar-container {
            margin-top: 4px;
          }
          @media (max-width: 1100px) {
            .top10-guilds-row,
            .top10-players-row { grid-template-columns: repeat(2, 1fr); }
          }
          @media (max-width: 700px) {
            .top10-guilds-row,
            .top10-players-row { grid-template-columns: 1fr; }
          }
        </style>`;

      $('#table-wrapper').html(html);
      $('#total-rows').text('DASHBOARD');

    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error(e);
      $('#table-wrapper').html('<div class="empty-state">Failed to load dashboard.</div>');
    }
  }

  // -------------------------- Persistência -----------------------------------
  function persistFilters(server, monthVal) {
    try {
      const year = $('#select-year').val();
      localStorage.setItem('ao:filters', JSON.stringify({ server, month: monthVal, year, view: STATE.view, main: STATE.main, sub: STATE.sub }));
    } catch { /* ignore */ }
  }
  function restoreFilters() {
    try {
      const raw = localStorage.getItem('ao:filters');
      if (!raw) return;
      const f = JSON.parse(raw);
      if (f.server) $('#select-server').val(f.server);
      if (f.year) $('#select-year').data('restore-year', f.year);
      if (f.month) $('#select-month').data('restore', f.month);
    } catch { /* ignore */ }
  }

  // ----------------------------- Bootstrap -----------------------------------
  $(document).ready(async () => {
    restoreFilters();

    // Callback chamado se HEAD probes de background encontrarem meses novos
    function onMonthsUpdated(freshAvailable) {
      const prevYear = parseInt($('#select-year').val(), 10);
      const prevMonth = $('#select-month').val();
      buildYearSelect(freshAvailable);
      const yr = prevYear && $('#select-year option[value="' + prevYear + '"]').length
        ? prevYear
        : parseInt($('#select-year').val(), 10) || YEARS_TO_SCAN[0];
      $('#select-year').val(yr);
      buildMonthSelectForYear(yr, STATE.sub === 'Month');
      // Mantém seleção anterior se ainda válida
      if (prevMonth && $('#select-month option[value="' + prevMonth + '"]').length) {
        $('#select-month').val(prevMonth);
      }
      // Só recarrega se a seleção mudou
      if ($('#select-month').val() !== prevMonth) loadData();
    }

    // Dispara discovery (instantâneo se months.json ou cache existir)
    const available = await discoverAvailableMonths(onMonthsUpdated);

    buildYearSelect(available);

    // Popula meses do ano mais recente como padrão inicial
    const defaultYear = parseInt($('#select-year').val(), 10) || YEARS_TO_SCAN[0];
    buildMonthSelectForYear(defaultYear, false);

    // Aplica valor salvo (se existir e for válido)
    const savedMonth = $('#select-month').data('restore');
    if (savedMonth) {
      const { year: savedYear } = parseMonthValue(savedMonth);
      if ($('#select-year option[value="' + savedYear + '"]').length) {
        $('#select-year').val(savedYear);
        buildMonthSelectForYear(savedYear, STATE.sub === 'Month');
        if ($('#select-month option[value="' + savedMonth + '"]').length) {
          $('#select-month').val(savedMonth);
        }
      }
    }

    $('#select-server, #select-month').on('change', loadData);

    // Ao mudar o ano: reconstrói lista de meses e recarrega
    $('#select-year').on('change', function () {
      const yr = parseInt($(this).val(), 10);
      buildMonthSelectForYear(yr, STATE.sub === 'Month');
      loadData();
    });

    $('.nav-item, .sidebar-link, .tab-btn').on('click', function () {
      $('.nav-item, .sidebar-link, .tab-btn').removeClass('active');
      $(this).addClass('active');

      const view = $(this).data('view') || $(this).text().trim();
      const lv = String(view).toLowerCase();

      if (lv.includes('home')) {
        STATE.view = 'HOME';
        $('#page-title').text('Home Dashboard');
        $('#page-subtitle').text('Analytical summary of the Albion Online competitive scene.');
        loadData();
        return;
      }

      STATE.view = 'LIST';

      if (lv.includes('geral') || lv.includes('general')) {
        STATE.main = 'General';
        STATE.sub = 'Battles';
      } else {
        STATE.main = (lv.includes('jogador') || lv.includes('player')) ? 'Players' : 'Guilds';
        if (lv.includes('batalha') || lv.includes('battle')) STATE.sub = 'Battles';
        else if (lv.includes('win rate') || lv.includes('winrate')) STATE.sub = 'WinRate';
        else STATE.sub = 'Month';
      }

      if (STATE.main === 'General') {
        $('#page-title').text('General // Battles');
        $('#page-subtitle').text('Raw records of general battles by server and period.');
      } else if (STATE.sub === 'WinRate') {
        $('#page-title').text('Guilds // Win Rate');
        $('#page-subtitle').text('Guild win/loss ratio ranking for the selected period.');
      } else {
        $('#page-title').text((STATE.main === 'Players' ? 'Players' : 'Guilds') + ' // ' + STATE.sub);
        $('#page-subtitle').text(
          STATE.sub === 'Battles' ? 'Raw battle records.' :
          'Consolidated ranking for the selected month or period.'
        );
      }

      const isMonth = STATE.sub === 'Month';
      const isBattle = STATE.sub === 'Battles' || STATE.main === 'General';
      const isWinRateView = STATE.sub === 'WinRate';

      $('#year-filter-container').toggle(isMonth || isBattle || isWinRateView);
      $('#month-filter-container').toggle(isMonth || isBattle || isWinRateView);

      const selectedYear = parseInt($('#select-year').val(), 10) || YEARS_TO_SCAN[0];
      buildMonthSelectForYear(selectedYear, isMonth || isBattle || isWinRateView);

      STATE.sortKey = STATE.sub === 'WinRate' ? 'WIN' : 'KILLS';
      STATE.sortAsc = false;
      loadData();
    });

    let searchTimer;
    $('#search-input').on('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyCurrentFilter, 150);
    });

    $('#clear-search').on('click', function () {
      $('#search-input').val('');
      $(this).hide();
      applyCurrentFilter();
    });

    // Clique no nome → preenche a busca
    $(document).on('click', '.clickable-name', function () {
      const n = $(this).data('name');
      if (!n) return;
      $('#search-input').val(n).trigger('input');
    });

    // Atalhos: "/" foca busca, "Esc" limpa
    $(document).on('keydown', function (e) {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        $('#search-input').focus();
      } else if (e.key === 'Escape' && document.activeElement.id === 'search-input') {
        $('#search-input').val('').trigger('input');
      }
    });

    loadData();
  });
})();