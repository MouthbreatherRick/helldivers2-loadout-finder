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
    let stratsPool  = uniq(
