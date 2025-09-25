/* =========================================================================
   Helldivers 2 — Loadout Finder + Squad Challenge + Mission Notes
   - Removes "Copy" UI
   - Adds a Solo Diving recommendation card (wide)
   - Mission Notes tab shows "Possible objectives" via objective mapping
   - Keeps community+curation logic, booster & grenade rules, banner, visitors
   ========================================================================= */

(() => {
  // --------------------------
  // Constants & Defaults
  // --------------------------
  const DEFAULTS = {
    faction: "Terminids (Bugs)",
    difficulty: "Challenging",
    objective: "Elimination",
    synergy: "balanced",
    roles: [
      { id: "heavy", name: "Heavy / Anti-Armor" },
      { id: "assault", name: "Assault (Versatile)" },
      { id: "recon", name: "Recon / Scout" },
      { id: "support", name: "Support Specialist" },
      { id: "medic", name: "Medic / Sustain" },
      { id: "demo", name: "Demolitions Expert" },
    ],
  };

  // Never exclude these stratagems
  const MUST_INCLUDE_STRATAGEMS = [
    "Quasar Cannon",
    "Orbital Napalm", // cover "Orbital Napalm Strike" variants
    "Emancipator",    // exosuit family
  ];

  const GRENADE_HINTS = {
    "Terminids (Bugs)": ["Incendiary", "Stun"],
    "Automatons (Bots)": ["Thermite", "EMP", "Anti-Armor"],
    "Illuminate (Squids)": ["EMP", "Stun", "Fragmentation"],
  };

  // --------------------------
  // State
  // --------------------------
  const STATE = {
    curated: {},
    items: {},
    usage: {},
    usageWeights: {},
    objectiveMapping: null, // from data.json.objectiveMapping or objective_mapping.json or fallback
    isReady: false,
  };

  // --------------------------
  // DOM
  // --------------------------
  const el = {
    tabs: null, panels: null,
    faction: null, difficulty: null, objective: null, synergy: null,
    reroll: null,
    finderGrid: null, challengeGrid: null,
    randomizeChallenge: null, enforceBoosters: null, factionGrenades: null,
    notesTitle: null, notesList: null, solo: {}
  };

  // --------------------------
  // Utils
  // --------------------------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.json();
  }

  function uniq(a){return [...new Set(a)]}
  function buildWhitelist(items) {
    const set = new Set();
    const add = (v) => {
      if (Array.isArray(v)) v.forEach(x => set.add(x));
      else if (v && typeof v === "object") Object.values(v).forEach(add);
    };
    ["primaries","sidearms","explosives","boosters","armor","stratagems"].forEach(k => add(items[k]));
    return set;
  }

  function ensureMustIncludeStratagems(strats, whitelist) {
    const out = [...strats];
    for (const req of MUST_INCLUDE_STRATAGEMS) {
      const has = out.some(s => s.toLowerCase().includes(req.toLowerCase().replace(/ strike| exosuit/g,"").trim()));
      if (!has) {
        const found = [...whitelist].find(w => w.toLowerCase().includes(req.toLowerCase().replace(/ strike| exosuit/g,"").trim()));
        if (found) out.push(found);
      }
    }
    return uniq(out);
  }

  // Flexible usage weights (works with unknown schemas)
  function buildUsageWeights(usageJson, filter = null) {
    const counts = new Map();
    const bump = (name, v=1) => counts.set(name, (counts.get(name)||0) + (isFinite(v)?Math.max(1, v):1));

    const matchFilter = (obj) => {
      if (!filter) return true;
      // very forgiving: if filter has faction/objective/difficulty, require substring match when those exist
      const f = filter.faction?.toLowerCase(); const o = filter.objective?.toLowerCase(); const d = filter.difficulty?.toLowerCase();
      const okF = !f || (obj.faction && (obj.faction+"").toLowerCase().includes(f));
      const okO = !o || (obj.objective || obj.objective_type || obj.type || obj.category || "")
                      .toString().toLowerCase().includes(o);
      const okD = !d || (obj.difficulty && (obj.difficulty+"").toLowerCase().includes(d));
      return okF && okO && okD;
    };

    const traverse = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(traverse); return; }
      if (typeof node === "object") {
        // If object looks like an item entry with a usage number:
        // We’ll consider standard fields across primaries/strats/boosters/etc.
        if (node.name && (node.count || node.uses || node.usage || node.usage_rate)) {
          if (matchFilter(node)) bump(node.name, Number(node.count ?? node.uses ?? node.usage ?? node.usage_rate));
        }
        Object.values(node).forEach(traverse);
      }
    };
    traverse(usageJson);

    // normalize
    let max = 0; for (const v of counts.values()) max = Math.max(max, v);
    const weights = {};
    counts.forEach((v,k) => weights[k] = max ? v/max : 0);
    return weights;
  }

  function rankByUsage(candidates, weights, baseBias = 0.1) {
    return [...candidates].map(n => ({n, w:(weights[n]||0)+baseBias}))
                          .sort((a,b)=>b.w-a.w).map(x=>x.n);
  }

  function pickGrenadeForFaction(faction, rankedExplosives, enforce=true){
    if (!enforce) return rankedExplosives[0] || null;
    const hints = GRENADE_HINTS[faction] || [];
    for (const h of hints) {
      const found = rankedExplosives.find(g => g.toLowerCase().includes(h.toLowerCase()));
      if (found) return found;
    }
    return rankedExplosives[0] || null;
  }

  function enforceBoosterRule(squad, rankedBoosters) {
    const counts = new Map(); const maxDup = 2;
    for (const m of squad) {
      const b = m.booster; if (!b) continue;
      counts.set(b,(counts.get(b)||0)+1);
      if (counts.get(b) > maxDup) {
        const idx = rankedBoosters.indexOf(b);
        let swapped=false;
        for (let i=idx+1;i<rankedBoosters.length;i++){
          const alt = rankedBoosters[i];
          if ((counts.get(alt)||0) < maxDup) { m.booster=alt; counts.set(alt,(counts.get(alt)||0)+1); swapped=true; break; }
        }
        if (!swapped){
          const any = rankedBoosters.find(x => (counts.get(x)||0) < maxDup);
          if (any){ m.booster = any; counts.set(any,(counts.get(any)||0)+1); }
        }
      }
    }
  }

  function synergyBiases(mode){
    switch(mode){
      case "anti-armor": return { antiArmor:.25, control:.05, sustain:.05, recon:.05 };
      case "control": return { control:.25, sustain:.05 };
      case "sustain": return { sustain:.25, control:.05 };
      case "recon": return { recon:.25, control:.05 };
      default: return {};
    }
  }

  function pickForRole({ roleId, curatedRole, items, weights, faction, synergyMode, whitelist }) {
    const roleBlock = curatedRole || {};
    const collect = (arr, more=[]) => uniq([...(arr||[]), ...more]).filter(n=>whitelist.has(n));
    const primaries = collect(roleBlock.primaries, items.primaries?.all);
    const sidearms  = collect(roleBlock.sidearms, items.sidearms?.all);
    const grenades  = collect(roleBlock.grenades, items.explosives?.all);
    let strats = collect(roleBlock.stratagems, uniq([
      ...(items.stratagems?.turrets||[]),
      ...(items.stratagems?.bombardments||[]),
      ...(items.stratagems?.deployables||[]),
      ...(items.stratagems?.backpacks||[]),
      ...(items.stratagems?.all||[]),
    ]));
    strats = ensureMustIncludeStratagems(strats, whitelist);
    const boosters = collect(roleBlock.boosters, items.boosters?.all);
    const armor    = collect(roleBlock.armor, items.armor?.all);

    const bias = synergyBiases(synergyMode);
    const roleBias =
      roleId === "heavy"   ? (bias.antiArmor||0) :
      roleId === "demo"    ? (bias.antiArmor||0.05) :
      roleId === "support" ? (bias.sustain||0.05) :
      roleId === "medic"   ? (bias.sustain||0.10) :
      roleId === "recon"   ? (bias.recon||0.10) :
      roleId === "assault" ? (bias.control||0.05) : 0;

    const rankedPrimaries = rankByUsage(primaries, weights, .10 + roleBias);
    const rankedSidearms  = rankByUsage(sidearms,  weights, .10);
    const rankedStrats    = rankByUsage(strats,    weights, .10 + (bias.control||0));
    const rankedBoosters  = rankByUsage(boosters,  weights, .10 + (bias.sustain||0));
    const rankedArmor     = rankByUsage(armor,     weights, .10);
    const rankedGrenades  = rankByUsage(grenades,  weights, .10 + (bias.control||0.02));

    return {
      roleId,
      primary: rankedPrimaries[0] || null,
      sidearm: rankedSidearms[0] || null,
      grenade: pickGrenadeForFaction(faction, rankedGrenades, true),
      booster: rankedBoosters[0] || null,
      armor:   rankedArmor[0] || null,
      stratagems: rankedStrats.slice(0,4),
    };
  }

  function roleLabel(id){
    const r = DEFAULTS.roles.find(x=>x.id===id); return r ? r.name : id;
  }

  // --------------------------
  // Rendering
  // --------------------------
  function renderSquadCards(container, squad){
    if (!container) return;
    container.innerHTML = "";
    squad.forEach(m=>{
      const card = document.createElement("div"); card.className="card";
      const h = document.createElement("h3"); h.textContent = roleLabel(m.roleId); card.appendChild(h);
      const kv = (k,v)=>{const w=document.createElement("div");w.className="kv";
        const a=document.createElement("div");a.className="key";a.textContent=k;
        const b=document.createElement("div");b.className="val";b.textContent=Array.isArray(v)?v.join(", "):(v||"—");
        w.appendChild(a);w.appendChild(b);return w;};
      card.appendChild(kv("Primary", m.primary));
      card.appendChild(kv("Sidearm", m.sidearm));
      card.appendChild(kv("Grenade", m.grenade));
      card.appendChild(kv("Booster", m.booster));
      card.appendChild(kv("Armor", m.armor));
      card.appendChild(kv("Stratagems", m.stratagems));
      container.appendChild(card);
    });
  }

  function showSkeletons(container,count=4){
    if(!container) return;
    container.innerHTML=""; for(let i=0;i<count;i++){const c=document.createElement("div");c.className="card skeleton";container.appendChild(c);}
  }

  // --------------------------
  // Solo Diving recommendation
  // --------------------------
  function renderSoloCard(whitelist){
    const context = document.getElementById("solo-context");
    const primary = document.getElementById("solo-primary");
    const sidearm = document.getElementById("solo-sidearm");
    const grenade = document.getElementById("solo-grenade");
    const booster = document.getElementById("solo-booster");
    const armor   = document.getElementById("solo-armor");
    const strats  = document.getElementById("solo-strats");

    // Filtered weights by current settings; fallback to global
    const filter = {
      faction: el.faction.value,
      objective: el.objective.value, // seven-type
      difficulty: el.difficulty.value
    };
    const filtered = buildUsageWeights(STATE.usage, filter);
    const weights = Object.keys(filtered).length ? filtered : STATE.usageWeights;

    // Build ranked lists from whitelist
    const primaries = (STATE.items.primaries?.all||[]).filter(n=>whitelist.has(n));
    const sidearmsL = (STATE.items.sidearms?.all||[]).filter(n=>whitelist.has(n));
    const grenadesL = (STATE.items.explosives?.all||[]).filter(n=>whitelist.has(n));
    const boostersL = (STATE.items.boosters?.all||[]).filter(n=>whitelist.has(n));
    const armorL    = (STATE.items.armor?.all||[]).filter(n=>whitelist.has(n));
    let stratsPool  = uniq([
      ...(STATE.items.stratagems?.turrets||[]),
      ...(STATE.items.stratagems?.bombardments||[]),
      ...(STATE.items.stratagems?.deployables||[]),
      ...(STATE.items.stratagems?.backpacks||[]),
      ...(STATE.items.stratagems?.all||[]),
    ]).filter(n=>whitelist.has(n));
    stratsPool = ensureMustIncludeStratagems(stratsPool, whitelist);

    const rPrim = rankByUsage(primaries, weights, .12);
    const rSide = rankByUsage(sidearmsL, weights, .10);
    const rGren = rankByUsage(grenadesL, weights, .10);
    const rBoost= rankByUsage(boostersL, weights, .10);
    const rArmor= rankByUsage(armorL,    weights, .10);
    const rStr  = rankByUsage(stratsPool,weights, .11);

    context.textContent = "Based on community usage for current filters";
    primary.textContent = rPrim[0] || "—";
    sidearm.textContent = rSide[0] || "—";
    grenade.textContent = pickGrenadeForFaction(el.faction.value, rGren, true) || "—";
    booster.textContent = rBoost[0] || "—";
    armor.textContent   = rArmor[0] || "—";
    strats.textContent  = (rStr.slice(0,4) || []).join(", ");
  }

  // --------------------------
  // Build squads
  // --------------------------
  function buildFinderSquad({ faction, synergyMode, curated, items, weights, whitelist }) {
    // Try to locate curated blocks keyed by seven-type objective (safe if you kept that structure)
    let roleBlocks = {};
    try { roleBlocks = ((curated[faction]||{})[el.difficulty.value]||{})[el.objective.value]?.roles || {}; } catch(e){}
    const squad = DEFAULTS.roles.map(r => pickForRole({
      roleId: r.id,
      curatedRole: roleBlocks[r.id],
      items, weights, faction, synergyMode, whitelist
    }));
    const rankedBoosters = rankByUsage(items.boosters?.all || [], weights, .1);
    enforceBoosterRule(squad, rankedBoosters);
    return squad;
  }

  function buildChallengeSquad({ faction, items, weights, whitelist, enforceFactionGrenades, enforceBoosters }) {
    const rand = a => a[Math.floor(Math.random()*a.length)] || null;
    const prim = (items.primaries?.all||[]).filter(n=>whitelist.has(n));
    const side = (items.sidearms?.all||[]).filter(n=>whitelist.has(n));
    const gren = (items.explosives?.all||[]).filter(n=>whitelist.has(n));
    const boos = (items.boosters?.all||[]).filter(n=>whitelist.has(n));
    const armr = (items.armor?.all||[]).filter(n=>whitelist.has(n));
    const stratPool = uniq([
      ...(items.stratagems?.turrets||[]),
      ...(items.stratagems?.bombardments||[]),
      ...(items.stratagems?.deployables||[]),
      ...(items.stratagems?.backpacks||[]),
      ...(items.stratagems?.all||[]),
    ]).filter(n=>whitelist.has(n));

    const rBoost = rankByUsage(boos, weights, .1);

    const squad = DEFAULTS.roles.map(r => ({
      roleId: r.id,
      primary: rand(prim),
      sidearm: rand(side),
      grenade: pickGrenadeForFaction(faction, rankByUsage(gren, weights, .05), enforceFactionGrenades),
      booster: rand(rBoost),
      armor: rand(armr),
      stratagems: uniq([rand(stratPool),rand(stratPool),rand(stratPool),rand(stratPool)]).slice(0,4),
    }));

    if (enforceBoosters) enforceBoosterRule(squad, rBoost);
    return squad;
  }

  // --------------------------
  // Mission Notes (Possible objectives)
  // --------------------------
  function renderMissionNotes() {
    const map = STATE.objectiveMapping;
    const title = document.getElementById("notes-title");
    const list = document.getElementById("notes-list");
    if (!map || !title || !list) return;

    const key = el.objective.value; // one of seven types
    const arr = map[key] || [];
    title.textContent = `Possible "${key}" Objectives:`;
    list.innerHTML = "";
    arr.forEach(name => {
      const li = document.createElement("li"); li.textContent = name; list.appendChild(li);
    });
  }

  // --------------------------
  // Tabs & Controls
  // --------------------------
  function initTabs(){
    el.tabs = Array.from(document.querySelectorAll(".tab"));
    el.panels = Array.from(document.querySelectorAll(".panel"));
    el.tabs.forEach(t=>{
      t.addEventListener("click",()=>{
        el.tabs.forEach(x=>x.classList.remove("active"));
        el.panels.forEach(p=>p.classList.remove("active"));
        t.classList.add("active");
        document.getElementById(t.dataset.tab).classList.add("active");
      });
    });
  }

  function bindControls(){
    el.faction = document.getElementById("faction");
    el.difficulty = document.getElementById("difficulty");
    el.objective = document.getElementById("objective");
    el.synergy = document.getElementById("team-synergy");
    el.reroll = document.getElementById("reroll");
    el.finderGrid = document.getElementById("finder-squad");
    el.challengeGrid = document.getElementById("challenge-squad");
    el.randomizeChallenge = document.getElementById("randomize-challenge");
    el.enforceBoosters = document.getElementById("enforce-boosters");
    el.factionGrenades = document.getElementById("faction-grenades");
    el.notesTitle = document.getElementById("notes-title");
    el.notesList = document.getElementById("notes-list");

    // defaults
    el.faction.value = DEFAULTS.faction;
    el.difficulty.value = DEFAULTS.difficulty;
    el.objective.value = DEFAULTS.objective;
    el.synergy.value = DEFAULTS.synergy;

    const rebuildFinder = () => {
      if (!STATE.isReady) return;
      const whitelist = buildWhitelist(STATE.items);
      // Solo card first
      renderSoloCard(whitelist);
      // Then role cards
      showSkeletons(el.finderGrid, 4);
      queueMicrotask(()=>{
        const squad = buildFinderSquad({
          faction: el.faction.value,
          synergyMode: el.synergy.value,
          curated: STATE.curated,
          items: STATE.items,
          weights: STATE.usageWeights,
          whitelist
        });
        renderSquadCards(el.finderGrid, squad);
      });
      // Update notes preview title
      renderMissionNotes();
    };

    [el.faction, el.difficulty, el.objective, el.synergy].forEach(c =>
      c.addEventListener("change", rebuildFinder)
    );
    el.reroll.addEventListener("click", rebuildFinder);

    el.randomizeChallenge?.addEventListener("click", ()=>{
      if (!STATE.isReady) return;
      const whitelist = buildWhitelist(STATE.items);
      showSkeletons(el.challengeGrid, 4);
      queueMicrotask(()=>{
        const s = buildChallengeSquad({
          faction: el.faction.value,
          items: STATE.items,
          weights: STATE.usageWeights,
          whitelist,
          enforceFactionGrenades: el.factionGrenades?.checked ?? true,
          enforceBoosters: el.enforceBoosters?.checked ?? true,
        });
        renderSquadCards(el.challengeGrid, s);
      });
    });
  }

  // --------------------------
  // Data Load & First Render
  // --------------------------
  async function loadAll(){
    showSkeletons(document.getElementById("finder-squad"), 4);
    showSkeletons(document.getElementById("challenge-squad"), 4);

    const [curated, items, usage] = await Promise.all([
      fetchJSON("data.json").catch(()=>({})),
      fetchJSON("items.json").catch(()=>({})),
      fetchJSON("helldive_live_merged_dataset.json").catch(()=>({})),
    ]);

    STATE.curated = curated || {};
    STATE.items = items || {};
    STATE.usage = usage || {};
    STATE.usageWeights = buildUsageWeights(STATE.usage);

    // Objective mapping: from data.json.objectiveMapping, else objective_mapping.json, else fallback
    let mapping = curated?.objectiveMapping || null;
    if (!mapping) {
      mapping = await fetchJSON("objective_mapping.json").catch(()=>null);
    }
    if (!mapping) {
      mapping = {
        "Elimination": [
          "Eliminate Bile Titans","Eliminate Chargers","Eliminate Brood Commander",
          "Eliminate Automaton Hulks","Eliminate Automaton Factory Strider","Eliminate Devastators",
          "Eliminate Impaler","Eradicate Terminid Swarm","Eradicate Automaton Forces"
        ],
        "Defense": [
          "Defend Evacuation Site","Defend Uplink","Protect Facility","Evacuate High-Value Assets"
        ],
        "Escort": [
          "Escort Convoy","Evacuate Colonists","Evacuate Personnel"
        ],
        "Capture/Activate": [
          "Activate Oil Pumps","Start Fuel Pumps","Activate SAM/AA/ICBM",
          "Conduct Geological Survey","Upload Escape Pod Data","Bring Uplink Online"
        ],
        "Sabotage/Destroy": [
          "Destroy Command Bunkers","Destroy Harvesters","Sabotage Air Base","Sabotage Supply Base",
          "Terminate Illegal Broadcast","Destroy Transmission Network","Nuke Nursery","Purge Hatcheries"
        ],
        "Retrieve/Carry": [
          "Retrieve Essential Personnel","Retrieve Recon Craft Intel","Recover Valuable Data","Carry Objective Item"
        ],
        "Final Extraction": [
          "Call Shuttle","Final Extraction"
        ]
      };
    }
    STATE.objectiveMapping = mapping;

    STATE.isReady = true;

    // First render pass
    const whitelist = buildWhitelist(STATE.items);
    renderSoloCard(whitelist);

    const squad = buildFinderSquad({
      faction: el.faction.value,
      synergyMode: el.synergy.value,
      curated: STATE.curated,
      items: STATE.items,
      weights: STATE.usageWeights,
      whitelist
    });
    renderSquadCards(el.finderGrid, squad);

    const challenge = buildChallengeSquad({
      faction: el.faction.value,
      items: STATE.items,
      weights: STATE.usageWeights,
      whitelist,
      enforceFactionGrenades: true,
      enforceBoosters: true,
    });
    renderSquadCards(el.challengeGrid, challenge);

    renderMissionNotes();
  }

  // --------------------------
  // Visitor Counter (increment + read)
  // --------------------------
  (function initVisitorCounter(){
    const elNum = document.getElementById("visitor-count");
    if (!elNum) return;

    const PROD_SLUG = "mouthbreathertv.com/helldivers"; // <- change to your deployed path (host+path, no trailing slash)
    const isHttp = location.protocol.startsWith("http");
    const slug = isHttp ? (location.hostname + location.pathname).replace(/\/$/,"") : PROD_SLUG;
    const LS_KEY = "visitorCountCache:"+slug;

    const cached = localStorage.getItem(LS_KEY);
    if (cached && /^\d+$/.test(cached)) elNum.textContent = cached;

    function ping(){
      const img = new Image();
      img.referrerPolicy = "no-referrer-when-downgrade";
      img.src = `https://hits.sh/${encodeURIComponent(slug)}.svg?view=total&_=${Date.now()}`;
    }
    function apply(svg){
      const m = svg.match(/>(\d[\d,]*)<\/text>/g);
      if(!m) return;
      const last = m[m.length-1].replace(/[^\d]/g,"");
      if (/^\d+$/.test(last)){ elNum.textContent = last; localStorage.setItem(LS_KEY,last); }
    }
    function read(n=0){
      fetch(`https://hits.sh/${encodeURIComponent(slug)}.svg?view=total&_=${Date.now()}`,{cache:"no-store"})
        .then(r=>r.text()).then(apply).catch(()=>{ if(n<3) setTimeout(()=>read(n+1), 250*(n+1)); });
    }
    ping(); setTimeout(()=>read(0), 300);
  })();

  // --------------------------
  // Boot
  // --------------------------
  document.addEventListener("DOMContentLoaded", async ()=>{
    initTabs();
    bindControls();
    try { await loadAll(); } catch (e) {
      console.error(e);
      const msg = (c)=>{ if(!c)return; c.innerHTML=""; const card=document.createElement("div");card.className="card";card.innerHTML="<p>Failed to load data. Refresh and try again.</p>"; c.appendChild(card); };
      msg(document.getElementById("finder-squad"));
      msg(document.getElementById("challenge-squad"));
    }
  });
})();
