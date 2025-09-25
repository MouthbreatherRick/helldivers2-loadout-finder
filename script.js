/* =========================================================================
   Helldivers 2 — Loadout Finder + Squad Challenge
   script.js (full replacement) — adds “select card + copy selected”
   ========================================================================= */

(() => {
  // --------------------------
  // Constants & Defaults
  // --------------------------
  const DEFAULTS = {
    faction: "Terminids (Bugs)",
    difficulty: "Challenging",
    synergy: "balanced",
    objective: "Destroy Nests",
    roles: [
      { id: "heavy", name: "Heavy / Anti-Armor" },
      { id: "assault", name: "Assault (Versatile)" },
      { id: "recon", name: "Recon / Scout" },
      { id: "support", name: "Support Specialist" },
      { id: "medic", name: "Medic / Sustain" },
      { id: "demo", name: "Demolitions Expert" },
    ],
    fallbackObjectives: [
      "Destroy Nests",
      "Eliminate Bile Titans",
      "Sabotage Facilities",
      "Escort Convoy",
      "Radiotower Uplink",
      "Extract Samples",
    ],
  };

  const MUST_INCLUDE_STRATAGEMS = [
    "Quasar Cannon",
    "Orbital Napalm",       // allow either “Orbital Napalm” or “… Strike”
    "Emancipator",         // allow “Emancipator Exosuit”
  ];

  const GRENADE_HINTS = {
    "Terminids (Bugs)": ["Incendiary", "Stun"],
    "Automatons (Bots)": ["Thermite", "EMP", "Anti-Armor"],
    "Illuminate (Squids)": ["EMP", "Stun", "Fragmentation"],
  };

  // Data cache
  const STATE = {
    curated: null,           // data.json
    items: null,             // items.json
    usage: null,             // helldive_live_merged_dataset.json
    usageWeights: {},        // name -> 0..1
    isReady: false,

    // selection state (per panel)
    selectedFinderIdx: null,
    selectedChallengeIdx: null,

    // last-built squads
    lastFinderSquad: [],
    lastChallengeSquad: [],
  };

  // DOM refs
  const el = {
    tabs: null,
    panels: null,
    faction: null,
    difficulty: null,
    objective: null,
    synergy: null,
    reroll: null,
    finderGrid: null,
    challengeGrid: null,
    randomizeChallenge: null,
    enforceBoosters: null,
    factionGrenades: null,
    visitorCount: null,
    copyFinder: null,
    copyChallenge: null,
  };

  // --------------------------
  // Utilities
  // --------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.json();
  }

  function uniq(arr) { return [...new Set(arr)]; }

  function buildWhitelist(items) {
    const set = new Set();
    const addCat = (obj) => {
      if (!obj) return;
      Object.values(obj).forEach((arr) => {
        if (Array.isArray(arr)) arr.forEach((n) => set.add(n));
        else if (arr && typeof arr === "object")
          Object.values(arr).forEach((inner) => {
            if (Array.isArray(inner)) inner.forEach((n) => set.add(n));
          });
      });
    };
    addCat(items.primaries);
    addCat(items.sidearms);
    addCat(items.explosives);
    addCat(items.boosters);
    addCat(items.armor);
    addCat(items.stratagems);
    return set;
  }

  function ensureMustIncludeStratagems(strats, whitelist) {
    const out = [...strats];
    for (const key of MUST_INCLUDE_STRATAGEMS) {
      const hasLoose = out.some((s) => s.toLowerCase().includes(key.toLowerCase()));
      if (!hasLoose) {
        const found = [...whitelist].find((w) => w.toLowerCase().includes(key.toLowerCase()));
        if (found) out.push(found);
      }
    }
    return uniq(out);
  }

  // Build normalized usage weights (name -> 0..1)
  function buildUsageWeights(usageJson) {
    const counts = new Map();
    const bump = (name, v) => counts.set(name, (counts.get(name) || 0) + (v || 1));

    const traverse = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach((e) => {
          if (e && typeof e === "object") {
            if (e.name) {
              const v = Number(e.count ?? e.uses ?? e.usage ?? e.usage_rate ?? 1);
              bump(e.name, Number.isFinite(v) ? Math.max(1, v) : 1);
            } else {
              traverse(e);
            }
          }
        });
      } else if (typeof node === "object") {
        Object.values(node).forEach(traverse);
      }
    };

    traverse(usageJson);

    let max = 0;
    for (const v of counts.values()) max = Math.max(max, v);
    const weights = {};
    for (const [k, v] of counts.entries()) {
      weights[k] = max > 0 ? v / max : 0;
    }
    return weights;
  }

  function rankByUsage(candidates, weights, baseBias = 0.1) {
    return [...candidates]
      .map((n) => ({ n, w: (weights[n] || 0) + baseBias }))
      .sort((a, b) => b.w - a.w)
      .map((x) => x.n);
  }

  function pickGrenadeForFaction(faction, availableExplosives, enforceFaction) {
    if (!enforceFaction) return availableExplosives[0] || null;
    const hints = GRENADE_HINTS[faction] || [];
    for (const h of hints) {
      const found = availableExplosives.find((g) => g.toLowerCase().includes(h.toLowerCase()));
      if (found) return found;
    }
    return availableExplosives[0] || null;
  }

  function enforceBoosterRule(squad, rankedBoosters) {
    const counts = new Map();
    const maxDup = 2;

    for (const member of squad) {
      const b = member.booster;
      if (!b) continue;
      counts.set(b, (counts.get(b) || 0) + 1);
      if (counts.get(b) > maxDup) {
        const currentIdx = rankedBoosters.indexOf(b);
        let swapped = false;
        for (let i = currentIdx + 1; i < rankedBoosters.length; i++) {
          const alt = rankedBoosters[i];
          if ((counts.get(alt) || 0) < maxDup) {
            member.booster = alt;
            counts.set(alt, (counts.get(alt) || 0) + 1);
            swapped = true;
            break;
          }
        }
        if (!swapped) {
          const any = rankedBoosters.find((x) => (counts.get(x) || 0) < maxDup);
          if (any) {
            member.booster = any;
            counts.set(any, (counts.get(any) || 0) + 1);
          }
        }
      }
    }
  }

  function synergyBiases(synergyMode) {
    switch (synergyMode) {
      case "anti-armor": return { antiArmor: 0.25, control: 0.05, sustain: 0.05, recon: 0.05 };
      case "control":    return { control: 0.25, sustain: 0.05 };
      case "sustain":    return { sustain: 0.25, control: 0.05 };
      case "recon":      return { recon: 0.25, control: 0.05 };
      default:           return {};
    }
  }

  function pickForRole({ roleId, curatedRole, items, weights, faction, synergyMode, whitelist, enforceFactionGrenades }) {
    const roleBlock = curatedRole || {};
    const primaries = uniq([...(roleBlock.primaries||[]), ...((items.primaries&&items.primaries.all)||[])]).filter(n=>whitelist.has(n));
    const sidearms  = uniq([...(roleBlock.sidearms||[]),  ...((items.sidearms&&items.sidearms.all)||[])]).filter(n=>whitelist.has(n));
    const explosives= uniq([...(roleBlock.grenades||[]),
                            ...((items.explosives&&items.explosives.grenades)||[]),
                            ...((items.explosives&&items.explosives.all)||[])]).filter(n=>whitelist.has(n));
    let strats      = uniq([...(roleBlock.stratagems||[]),
                            ...((items.stratagems&&items.stratagems.turrets)||[]),
                            ...((items.stratagems&&items.stratagems.bombardments)||[]),
                            ...((items.stratagems&&items.stratagems.deployables)||[]),
                            ...((items.stratagems&&items.stratagems.backpacks)||[]),
                            ...((items.stratagems&&items.stratagems.all)||[])]).filter(n=>whitelist.has(n));
    strats = ensureMustIncludeStratagems(strats, whitelist);

    const boosters  = uniq([...(roleBlock.boosters||[]),  ...((items.boosters&&items.boosters.all)||[])]).filter(n=>whitelist.has(n));
    const armor     = uniq([...(roleBlock.armor||[]),     ...((items.armor&&items.armor.all)||[])]).filter(n=>whitelist.has(n));

    const bias = synergyBiases(synergyMode);
    const baseBias = 0.10;
    const roleBias =
      roleId === "heavy"   ? (bias.antiArmor || 0) :
      roleId === "demo"    ? (bias.antiArmor || 0.05) :
      roleId === "support" ? (bias.sustain   || 0.05) :
      roleId === "medic"   ? (bias.sustain   || 0.10) :
      roleId === "recon"   ? (bias.recon     || 0.10) :
      roleId === "assault" ? (bias.control   || 0.05) : 0;

    const rankedPrimaries = rankByUsage(primaries, weights, baseBias + roleBias);
    const rankedSidearms  = rankByUsage(sidearms,  weights, baseBias);
    const rankedStrats    = rankByUsage(strats,    weights, baseBias + (bias.control||0));
    const rankedBoosters  = rankByUsage(boosters,  weights, baseBias + (bias.sustain||0));
    const rankedArmor     = rankByUsage(armor,     weights, baseBias);
    const rankedGrenades  = rankByUsage(explosives,weights, baseBias + (bias.control||0.02));

    return {
      roleId,
      primary: rankedPrimaries[0] || null,
      sidearm: rankedSidearms[0]  || null,
      grenade: pickGrenadeForFaction(faction, rankedGrenades, enforceFactionGrenades),
      booster: rankedBoosters[0]  || null,
      armor:   rankedArmor[0]     || null,
      stratagems: rankedStrats.slice(0, 4),
    };
  }

  function buildFinderSquad({ faction, difficulty, synergyMode, objective, curated, items, weights, whitelist, enforceFactionGrenades }) {
    let roleBlocks = {};
    try {
      roleBlocks = (((curated[faction]||{})[difficulty]||{})[objective]||{}).roles || {};
    } catch (e) { roleBlocks = {}; }

    const squad = DEFAULTS.roles.map((r) =>
      pickForRole({
        roleId: r.id,
        curatedRole: roleBlocks[r.id],
        items, weights, faction, synergyMode, whitelist, enforceFactionGrenades
      })
    );

    const allBoostersRanked = rankByUsage((items.boosters&&items.boosters.all)||[], weights, 0.1);
    enforceBoosterRule(squad, allBoostersRanked);
    return squad;
  }

  function buildChallengeSquad({ faction, enforceFactionGrenades, items, weights, whitelist }) {
    const randPick = (arr) => arr[Math.floor(Math.random() * arr.length)] || null;

    const primaries = ((items.primaries&&items.primaries.all)||[]).filter(n=>whitelist.has(n));
    const sidearms  = ((items.sidearms&&items.sidearms.all)||[]).filter(n=>whitelist.has(n));
    const grenades  = ((items.explosives&&items.explosives.all)||[]).filter(n=>whitelist.has(n));
    const boosters  = ((items.boosters&&items.boosters.all)||[]).filter(n=>whitelist.has(n));
    const armor     = ((items.armor&&items.armor.all)||[]).filter(n=>whitelist.has(n));
    const stratPool = uniq([
      ...((items.stratagems&&items.stratagems.turrets)||[]),
      ...((items.stratagems&&items.stratagems.bombardments)||[]),
      ...((items.stratagems&&items.stratagems.deployables)||[]),
      ...((items.stratagems&&items.stratagems.backpacks)||[]),
      ...((items.stratagems&&items.stratagems.all)||[]),
    ]).filter(n=>whitelist.has(n));

    const rankedBoosters = rankByUsage(boosters, weights, 0.1);

    const squad = DEFAULTS.roles.map((r) => {
      const stratagems = uniq([randPick(stratPool), randPick(stratPool), randPick(stratPool), randPick(stratPool)]).slice(0,4);
      return {
        roleId: r.id,
        primary: randPick(primaries),
        sidearm: randPick(sidearms),
        grenade: pickGrenadeForFaction(faction, rankByUsage(grenades, weights, 0.05), enforceFactionGrenades),
        booster: randPick(rankedBoosters),
        armor:   randPick(armor),
        stratagems,
      };
    });

    enforceBoosterRule(squad, rankedBoosters);
    return squad;
  }

  // --------------------------
  // Rendering + Selection
  // --------------------------
  function roleLabel(roleId) {
    const found = DEFAULTS.roles.find((r) => r.id === roleId);
    return found ? found.name : roleId;
  }

  function renderSquadCards(container, squad, panel) {
    if (!container) return;
    container.innerHTML = "";
    squad.forEach((m, idx) => {
      const card = document.createElement("div");
      card.className = "card selectable";
      card.tabIndex = 0; // focusable for keyboard
      card.setAttribute("role", "button");
      card.setAttribute("aria-pressed", "false");
      card.dataset.index = String(idx);
      card.dataset.panel = panel;

      const h = document.createElement("h3");
      h.textContent = roleLabel(m.roleId);
      card.appendChild(h);

      const row1 = document.createElement("div");
      row1.className = "row";
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "Optimized by Community + Curation";
      row1.appendChild(b);
      card.appendChild(row1);

      const kv = (k, v) => {
        const wrap = document.createElement("div");
        wrap.className = "kv";
        const key = document.createElement("div");
        key.className = "key";
        key.textContent = k;
        const val = document.createElement("div");
        val.className = "val";
        val.textContent = Array.isArray(v) ? v.join(", ") : (v || "—");
        wrap.appendChild(key);
        wrap.appendChild(val);
        return wrap;
      };

      card.appendChild(kv("Primary", m.primary));
      card.appendChild(kv("Sidearm", m.sidearm));
      card.appendChild(kv("Grenade", m.grenade));
      card.appendChild(kv("Booster", m.booster));
      card.appendChild(kv("Armor", m.armor));
      card.appendChild(kv("Stratagems", m.stratagems));

      // selection behavior
      card.addEventListener("click", () => toggleSelection(card));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleSelection(card);
        }
      });

      container.appendChild(card);
    });

    // Reset selection state on re-render
    if (panel === "finder") {
      STATE.selectedFinderIdx = null;
      setCopyButtonEnabled(el.copyFinder, false);
    } else {
      STATE.selectedChallengeIdx = null;
      setCopyButtonEnabled(el.copyChallenge, false);
    }
  }

  function toggleSelection(cardEl) {
    const panel = cardEl.dataset.panel;
    const container = panel === "finder" ? el.finderGrid : el.challengeGrid;
    const btn = panel === "finder" ? el.copyFinder : el.copyChallenge;

    // Clear previous selection in that panel
    Array.from(container.querySelectorAll(".card.selected")).forEach((c) => {
      c.classList.remove("selected");
      c.setAttribute("aria-pressed", "false");
    });

    // Select this one
    cardEl.classList.add("selected");
    cardEl.setAttribute("aria-pressed", "true");
    const idx = Number(cardEl.dataset.index);
    if (panel === "finder") {
      STATE.selectedFinderIdx = idx;
    } else {
      STATE.selectedChallengeIdx = idx;
    }
    setCopyButtonEnabled(btn, true);
  }

  function setCopyButtonEnabled(button, enabled) {
    if (!button) return;
    button.disabled = !enabled;
  }

  // Build a shareable/plain-text snippet for clipboard
  function formatLoadoutText(member, extra = {}) {
    const lines = [];
    if (extra.title) lines.push(extra.title);
    lines.push(`Role: ${roleLabel(member.roleId)}`);
    if (extra.context) lines.push(extra.context);
    lines.push(`Primary: ${member.primary ?? "—"}`);
    lines.push(`Sidearm: ${member.sidearm ?? "—"}`);
    lines.push(`Grenade: ${member.grenade ?? "—"}`);
    lines.push(`Booster: ${member.booster ?? "—"}`);
    lines.push(`Armor: ${member.armor ?? "—"}`);
    lines.push(`Stratagems: ${Array.isArray(member.stratagems) ? member.stratagems.join(", ") : "—"}`);
    return lines.join("\n");
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "Copied!";
        btn.disabled = true;
        setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 900);
      }
    } catch {
      // Fallback: create a hidden textarea
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "Copied!";
        btn.disabled = true;
        setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 900);
      }
    }
  }

  // --------------------------
  // Tabs & Controls
  // --------------------------
  function initTabs() {
    el.tabs = Array.from(document.querySelectorAll(".tab"));
    el.panels = Array.from(document.querySelectorAll(".panel"));

    el.tabs.forEach((t) => {
      t.addEventListener("click", () => {
        el.tabs.forEach((x) => x.classList.remove("active"));
        el.panels.forEach((p) => p.classList.remove("active"));
        t.classList.add("active");
        const id = t.dataset.tab;
        document.getElementById(id).classList.add("active");
      });
    });
  }

  function bindControls() {
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
    el.visitorCount = document.getElementById("visitor-count");
    el.copyFinder = document.getElementById("copy-finder");
    el.copyChallenge = document.getElementById("copy-challenge");

    el.faction.value = DEFAULTS.faction;
    el.difficulty.value = DEFAULTS.difficulty;
    el.synergy.value = "balanced";

    const onChangeFinder = () => {
      if (!STATE.isReady) return;
      showSkeletons(el.finderGrid, 4);
      queueMicrotask(async () => {
        const whitelist = buildWhitelist(STATE.items);
        const squad = buildFinderSquad({
          faction: el.faction.value,
          difficulty: el.difficulty.value,
          synergyMode: el.synergy.value,
          objective: el.objective.value,
          curated: STATE.curated,
          items: STATE.items,
          weights: STATE.usageWeights,
          whitelist,
          enforceFactionGrenades: true,
        });
        STATE.lastFinderSquad = squad;
        renderSquadCards(el.finderGrid, squad, "finder");
      });
    };

    el.faction.addEventListener("change", () => {
      populateObjectivesSelect(STATE.curated, STATE.usage, el.faction.value, el.difficulty.value, el.objective);
      onChangeFinder();
    });
    el.difficulty.addEventListener("change", () => {
      populateObjectivesSelect(STATE.curated, STATE.usage, el.faction.value, el.difficulty.value, el.objective);
      onChangeFinder();
    });
    el.objective.addEventListener("change", onChangeFinder);
    el.synergy.addEventListener("change", onChangeFinder);
    el.reroll.addEventListener("click", onChangeFinder);

    el.randomizeChallenge.addEventListener("click", () => {
      if (!STATE.isReady) return;
      showSkeletons(el.challengeGrid, 4);
      queueMicrotask(() => {
        const whitelist = buildWhitelist(STATE.items);
        const squad = buildChallengeSquad({
          faction: el.faction.value,
          enforceFactionGrenades: el.factionGrenades.checked,
          items: STATE.items,
          weights: STATE.usageWeights,
          whitelist,
        });
        if (el.enforceBoosters.checked) {
          const ranked = rankByUsage((STATE.items.boosters && STATE.items.boosters.all) || [], STATE.usageWeights, 0.1);
          enforceBoosterRule(squad, ranked);
        }
        STATE.lastChallengeSquad = squad;
        renderSquadCards(el.challengeGrid, squad, "challenge");
      });
    });

    // Copy buttons (only selected)
    el.copyFinder.addEventListener("click", () => {
      const idx = STATE.selectedFinderIdx;
      if (idx == null) return;
      const m = STATE.lastFinderSquad[idx];
      const txt = formatLoadoutText(m, {
        title: "Helldivers 2 – Finder Loadout",
        context: `${el.faction.value} · ${el.difficulty.value} · ${el.objective.value} · Synergy: ${el.synergy.value}`
      });
      copyText(txt, el.copyFinder);
    });

    el.copyChallenge.addEventListener("click", () => {
      const idx = STATE.selectedChallengeIdx;
      if (idx == null) return;
      const m = STATE.lastChallengeSquad[idx];
      const txt = formatLoadoutText(m, {
        title: "Helldivers 2 – Squad Challenge Loadout",
        context: `${el.faction.value} · Faction grenades: ${el.factionGrenades.checked ? "ON" : "OFF"}`
      });
      copyText(txt, el.copyChallenge);
    });
  }

  // --------------------------
  // Objective list
  // --------------------------
  function populateObjectivesSelect(curated, usage, faction, difficulty, selEl) {
    const fromCurated = new Set();
    try {
      const factionNode = curated[faction] || {};
      const diffNode = factionNode[difficulty] || {};
      Object.keys(diffNode).forEach((obj) => fromCurated.add(obj));
    } catch (e) {}

    const fromUsage = new Set();
    const scanUsage = (node) => {
      if (!node) return;
      if (Array.isArray(node)) node.forEach(scanUsage);
      else if (typeof node === "object") {
        if (node.objective && typeof node.objective === "string") fromUsage.add(node.objective);
        Object.values(node).forEach(scanUsage);
      }
    };
    scanUsage(usage);

    const merged = uniq([...Array.from(fromCurated), ...Array.from(fromUsage), ...DEFAULTS.fallbackObjectives]);

    selEl.innerHTML = "";
    merged.forEach((o) => {
      const opt = document.createElement("option");
      opt.textContent = o;
      selEl.appendChild(opt);
    });

    const desired = merged.find((x) => x.toLowerCase().includes("nest")) || merged[0];
    selEl.value = desired || merged[0] || DEFAULTS.objective;
  }

  // --------------------------
  // Skeletons & Errors
  // --------------------------
  function showSkeletons(container, count = 4) {
    if (!container) return;
    container.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const c = document.createElement("div");
      c.className = "card skeleton";
      container.appendChild(c);
    }
  }

  // --------------------------
  // Data Load & First Render
  // --------------------------
  async function loadAll() {
    showSkeletons(document.getElementById("finder-squad"), 4);
    showSkeletons(document.getElementById("challenge-squad"), 4);

    const [curated, items, usage] = await Promise.all([
      fetchJSON("data.json"),
      fetchJSON("items.json"),
      fetchJSON("helldive_live_merged_dataset.json"),
    ]);

    STATE.curated = curated || {};
    STATE.items = items || {};
    STATE.usage = usage || {};
    STATE.usageWeights = buildUsageWeights(STATE.usage);
    STATE.isReady = true;

    populateObjectivesSelect(STATE.curated, STATE.usage, el.faction.value, el.difficulty.value, el.objective);

    const whitelist = buildWhitelist(STATE.items);

    const finderSquad = buildFinderSquad({
      faction: el.faction.value,
      difficulty: el.difficulty.value,
      synergyMode: el.synergy.value,
      objective: el.objective.value,
      curated: STATE.curated,
      items: STATE.items,
      weights: STATE.usageWeights,
      whitelist,
      enforceFactionGrenades: true,
    });
    STATE.lastFinderSquad = finderSquad;
    renderSquadCards(el.finderGrid, finderSquad, "finder");

    const challengeSquad = buildChallengeSquad({
      faction: el.faction.value,
      enforceFactionGrenades: el.factionGrenades.checked,
      items: STATE.items,
      weights: STATE.usageWeights,
      whitelist,
    });
    if (el.enforceBoosters.checked) {
      const ranked = rankByUsage((STATE.items.boosters && STATE.items.boosters.all) || [], STATE.usageWeights, 0.1);
      enforceBoosterRule(challengeSquad, ranked);
    }
    STATE.lastChallengeSquad = challengeSquad;
    renderSquadCards(el.challengeGrid, challengeSquad, "challenge");
  }

  // --------------------------
  // Visitor Counter (hits.sh)
  // --------------------------
  (function initVisitorCounter() {
    const elNum = document.getElementById("visitor-count");
    if (!elNum) return;

    // IMPORTANT: set this to your deployed host+path (no trailing slash).
    const PROD_SLUG = "mouthbreathertv.com/helldivers"; // <-- update to your real URL

    const isHttp = location.protocol.startsWith("http");
    const runtimeSlug = isHttp ? (location.hostname + location.pathname).replace(/\/$/, "") : PROD_SLUG;

    const LS_KEY = "visitorCountCache:" + runtimeSlug;
    const cached = localStorage.getItem(LS_KEY);
    if (cached && /^\d+$/.test(cached)) elNum.textContent = cached;

    function ping() {
      const img = new Image();
      img.referrerPolicy = "no-referrer-when-downgrade";
      img.src = `https://hits.sh/${encodeURIComponent(runtimeSlug)}.svg?view=total&_=${Date.now()}`;
    }

    function applyCountFromSvg(svgText) {
      const matches = svgText.match(/>(\d[\d,]*)<\/text>/g);
      if (!matches) throw new Error("No numeric <text> in hits SVG");
      const last = matches[matches.length - 1].replace(/[^\d]/g, "");
      if (/^\d+$/.test(last)) {
        elNum.textContent = last;
        localStorage.setItem(LS_KEY, last);
      }
    }

    function fetchCount(tryNum = 0) {
      fetch(`https://hits.sh/${encodeURIComponent(runtimeSlug)}.svg?view=total&_=${Date.now()}`, { cache: "no-store" })
        .then((r) => r.text())
        .then(applyCountFromSvg)
        .catch(() => {
          if (tryNum < 3) setTimeout(() => fetchCount(tryNum + 1), 250 * (tryNum + 1));
        });
    }

    ping();
    setTimeout(() => fetchCount(0), 300);
  })();

  // --------------------------
  // Boot
  // --------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    initTabs();
    bindControls();
    try {
      await loadAll();
    } catch (err) {
      console.error(err);
      const showErr = (container) => {
        if (!container) return;
        container.innerHTML = "";
        const c = document.createElement("div");
        c.className = "card";
        const p = document.createElement("p");
        p.textContent = "Failed to load data. Please refresh.";
        c.appendChild(p);
        container.appendChild(c);
      };
      showErr(document.getElementById("finder-squad"));
      showErr(document.getElementById("challenge-squad"));
    }
  });
})();
