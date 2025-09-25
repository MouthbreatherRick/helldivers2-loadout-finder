let DATA = [];
let ITEMS = {};
let itemsReady = false;

const $ = sel => document.querySelector(sel);
const factionSel = $("#faction"), difficultySel = $("#difficulty"), objectiveSel = $("#objective");
const results = $("#results"), compNote = $("#compNote");

/* ---------------- tolerant key map (supports multiple field names) ---------------- */
const keyMap = {
  faction: "Faction",
  difficulty: "Difficulty",
  objective: "Objective",
  note: "Recommended_Team_Composition_Notes",

  class: ["Class_1","Class_2","Class_3","Class_4","Class_5","Class_6"],

  weapons: [
    ["C1_Primary_Weapons","C1_Primary","C1_Weapons"],
    ["C2_Primary_Weapons","C2_Primary","C2_Weapons"],
    ["C3_Primary_Weapons","C3_Primary","C3_Weapons"],
    ["C4_Primary_Weapons","C4_Primary","C4_Weapons"],
    ["C5_Primary_Weapons","C5_Primary","C5_Weapons"],
    ["C6_Primary_Weapons","C6_Primary","C6_Weapons"],
  ],
  sidearms: [
    ["C1_Sidearm","C1_Secondary","C1_Sidearms"],
    ["C2_Sidearm","C2_Secondary","C2_Sidearms"],
    ["C3_Sidearm","C3_Secondary","C3_Sidearms"],
    ["C4_Sidearm","C4_Secondary","C4_Sidearms"],
    ["C5_Sidearm","C5_Secondary","C5_Sidearms"],
    ["C6_Sidearm","C6_Secondary","C6_Sidearms"],
  ],
  explosives: [
    ["C1_Explosive","C1_Grenade","C1_Throwable"],
    ["C2_Explosive","C2_Grenade","C2_Throwable"],
    ["C3_Explosive","C3_Grenade","C3_Throwable"],
    ["C4_Explosive","C4_Grenade","C4_Throwable"],
    ["C5_Explosive","C5_Grenade","C5_Throwable"],
    ["C6_Explosive","C6_Grenade","C6_Throwable"],
  ],
  // supports Armor/Boosters phrasing
  armor: [
    ["C1_Armor_boosters","C1_Armor_Perks","C1_Armor"],
    ["C2_Armor_boosters","C2_Armor_Perks","C2_Armor"],
    ["C3_Armor_boosters","C3_Armor_Perks","C3_Armor"],
    ["C4_Armor_boosters","C4_Armor_Perks","C4_Armor"],
    ["C5_Armor_boosters","C5_Armor_Perks","C5_Armor"],
    ["C6_Armor_boosters","C6_Armor_Perks","C6_Armor"],
  ],
  strats: [
    ["C1_Stratagems","C1_Strategems","C1_Strats"],
    ["C2_Stratagems","C2_Strategems","C2_Strats"],
    ["C3_Stratagems","C3_Strategems","C3_Strats"],
    ["C4_Stratagems","C4_Strategems","C4_Strats"],
    ["C5_Stratagems","C5_Strategems","C5_Strats"],
    ["C6_Stratagems","C6_Strategems","C6_Strats"],
  ],
};

// first non-empty key from a candidate list
function pickField(row, candidates) {
  if (!Array.isArray(candidates)) return row[candidates];
  for (const k of candidates) {
    if (k in row && row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  return "";
}

function showError(msg){
  const box = document.querySelector('.errorbox');
  document.getElementById('errors').style.display='block';
  box.textContent = msg;
  console.error(msg);
}

async function load(){
  try{
    // Load BOTH files first
    const [dataRes, itemsRes] = await Promise.all([
      fetch('data.json?cb=' + Date.now()),
      fetch('items.json?cb=' + Date.now())
    ]);
    if(!dataRes.ok) throw new Error('Failed to load data.json: ' + dataRes.status);
    if(!itemsRes.ok) throw new Error('Failed to load items.json: ' + itemsRes.status);

    DATA  = await dataRes.json();
    ITEMS = await itemsRes.json();
    buildWhitelistFromItems(); // <-- fill WL sets before we render anything

  }catch(e){
    showError(e.message || String(e));
    return;
  }

  // Populate selectors from DATA
  initSelectors();

  // Choose initial values (URL if valid; otherwise first row)
  const url = new URL(window.location);
  const has = (field, val) => DATA.some(r => r[field] === val);

  let f = url.searchParams.get('faction');
  let d = url.searchParams.get('difficulty');
  let o = url.searchParams.get('objective');

  if(!f || !has(keyMap.faction, f))     f = DATA[0][keyMap.faction];
  if(!d || !has(keyMap.difficulty, d))  d = DATA[0][keyMap.difficulty];
  if(!o || !has(keyMap.objective,  o))  o = DATA[0][keyMap.objective];

  factionSel.value = f;
  difficultySel.value = d;
  objectiveSel.value = o;

  // Now it's safe to render (WL + DATA are ready)
  render();

  // Set up challenge selectors
  optionize($("#challengeFaction"), ["Random", ...(ITEMS.factions || [])]);
  optionize($("#challengeDifficulty"), ["Random", ...(ITEMS.difficulties || [])]);
}

function uniqueBy(field){ return [...new Set(DATA.map(r=>r[field]).filter(Boolean))]; }
function optionize(sel, values){ sel.innerHTML = values.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join(''); }

function initSelectors(){
  optionize(factionSel, uniqueBy(keyMap.faction));
  optionize(difficultySel, uniqueBy(keyMap.difficulty));
  optionize(objectiveSel, uniqueBy(keyMap.objective));
  [factionSel,difficultySel,objectiveSel].forEach(el=>el.addEventListener('change',render));
  $("#shareBtn").addEventListener('click',()=>navigator.clipboard.writeText(location.href).then(()=>alert('Shareable link copied!')));
  $("#copyBtn").addEventListener('click',copyText);
}

function findRow(f,d,o){ return DATA.find(r=>r[keyMap.faction]===f && r[keyMap.difficulty]===d && r[keyMap.objective]===o); }

function render(){
  if(!itemsReady || !DATA.length) return; // avoid early blanking

  const f = factionSel.value, d = difficultySel.value, o = objectiveSel.value;
  const row = findRow(f,d,o);
  const params = new URLSearchParams({ faction:f, difficulty:d, objective:o });
  history.replaceState(null,"","?"+params.toString());

  if(!row){
    results.innerHTML = '<div class="card"><div class="role">No data found</div></div>';
    compNote.textContent = '';
    return;
  }

  compNote.textContent = row[keyMap.note] || '';

  const cards=[];
  for(let i=0;i<6;i++){
    const role      = pickField(row, keyMap.class[i]);
    const primRaw   = pickField(row, keyMap.weapons[i]);
    const sideRaw   = pickField(row, keyMap.sidearms[i]);
    const explRaw   = pickField(row, keyMap.explosives[i]);
    const armorRaw  = pickField(row, keyMap.armor[i]);
    const stratRaw  = pickField(row, keyMap.strats[i]);

    const primaries  = filterToWhitelist(primRaw,  WL.primaries,  `Primary (Class ${i+1})`).join(', ') || '-';
    const sidearms   = filterToWhitelist(sideRaw,  WL.sidearms,   `Sidearm (Class ${i+1})`).join(', ') || '-';
    const explosives = filterToWhitelist(explRaw,  WL.explosives, `Explosive (Class ${i+1})`).join(', ') || '-';
    const stratagems = filterToWhitelist(stratRaw, WL.stratagems, `Stratagems (Class ${i+1})`).join(', ') || '-';

    cards.push(card(role, primaries, sidearms, explosives, armorRaw, stratagems));
  }
  results.innerHTML = cards.join('');
}


function card(role,primary,sidearm,explosive,armor,strats){
  const row = (label, val) => !val ? '' :
    `<div class="kv"><b>${label}</b><div>${escapeHtml(val)}</div></div>`;
  return `<article class="card">
    <div class="role">${escapeHtml(role||"Role")}</div>
    ${row('Primary Weapons', primary)}
    ${row('Sidearm', sidearm)}
    ${row('Explosive', explosive)}
    ${row('Armor / Boosters', armor)}
    ${row('Stratagems', strats)}
  </article>`;
}

function copyText(){
  const f=factionSel.value, d=difficultySel.value, o=objectiveSel.value;
  const row=findRow(f,d,o);
  if(!row) return;

  let out=`${f} | ${d} | ${o}\n${row[keyMap.note]||''}\n\n`;

  for(let i=0;i<6;i++){
    const prim = filterToWhitelist(pickField(row,keyMap.weapons[i]), WL.primaries,  `Primary (Class ${i+1})`).join(', ') || '-';
    const sid  = filterToWhitelist(pickField(row,keyMap.sidearms[i]), WL.sidearms,   `Sidearm (Class ${i+1})`).join(', ') || '-';
    const exp  = filterToWhitelist(pickField(row,keyMap.explosives[i]), WL.explosives, `Explosive (Class ${i+1})`).join(', ') || '-';
    const arm  = pickField(row,keyMap.armor[i]) || '-';
    const st   = filterToWhitelist(pickField(row,keyMap.strats[i]), WL.stratagems, `Stratagems (Class ${i+1})`).join(', ') || '-';

    out += `• ${pickField(row,keyMap.class[i])}
   - Primary: ${prim}
   - Sidearm: ${sid}
   - Explosive: ${exp}
   - Armor/Boosters: ${arm}
   - Stratagems: ${st}\n\n`;
  }
  navigator.clipboard.writeText(out).then(()=>alert('Loadout copied!'));
}

function escapeHtml(s){ return (s??'').toString().replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

/* ---------------- sanitizers for Finder fields ---------------- */
function splitTokens(text){
  if(!text) return [];
  return String(text)
    .split(/[/,;\n]/g)
    .map(t=>t.trim())
    .filter(Boolean);
}
function buildSet(arr){ return new Set((arr||[]).map(x=>String(x).trim())); }
function filterToWhitelist(text, whitelistSet, fieldLabel){
  const tokens = splitTokens(text);
  const kept = [];
  const dropped = [];
  for(const t of tokens){
    if(whitelistSet.has(t)) kept.push(t);
    else dropped.push(t);
  }
  if(dropped.length){
    console.warn(`[Finder sanitize] Dropped from ${fieldLabel}:`, dropped, ' | kept:', kept);
  }
  return kept;
}
let WL = { primaries:new Set(), sidearms:new Set(), explosives:new Set(), stratagems:new Set() };

/* -------------------------------- Tabs -------------------------------- */
document.addEventListener('click', (e)=>{
  const tab = e.target.closest('.tab');
  if(!tab) return;
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  tab.classList.add('active');
  const t=tab.dataset.tab;
  document.querySelector('#challenge').classList.toggle('hidden', t!=='challenge');
  document.querySelector('.controls').classList.toggle('hidden', t!=='finder');
  document.querySelector('.note').classList.toggle('hidden', t!=='finder');
  document.querySelector('#results').classList.toggle('hidden', t!=='finder');
});

/* ------------------------------- Challenge ------------------------------ */
function rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function pickOrdered(pool, altCount=2){
  const s = [...pool].sort(()=>Math.random() - 0.5);
  return { main: s[0] || '', alts: s.slice(1, 1 + altCount) };
}
function genPlayerBuild(){
  const primary   = pickOrdered(ITEMS.primaries, 2);
  const sidearm   = pickOrdered(ITEMS.sidearms, 2);
  const explosive = pickOrdered(ITEMS.explosives, 2);
  const armor     = rand(ITEMS.armor_weights);
  const booster   = pickOrdered(ITEMS.boosters, 2); // boosters instead of perks

  const allStrats = [
    ...(ITEMS.stratagems?.turrets || []),
    ...(ITEMS.stratagems?.bombardment || []),
    ...(ITEMS.stratagems?.deployables || [])
  ].sort(() => Math.random() - 0.5);

  const stratMain = allStrats.slice(0, 4);
  const stratAlt  = allStrats.slice(4, 6); // 2 alternates

  return { primary, sidearm, explosive, armor, booster, stratMain, stratAlt };
}
function orderedBlock(title, picks){
  const main = escapeHtml((picks.main||'').toString());
  const alts = (picks.alts||[]).map(x=>escapeHtml(x));
  const label = alts.length === 1 ? 'Alternate' : 'Alternates';
  return `<div class="kv"><b>${title}</b>
    <div>${main}</div>
    <div class="small"><b>${label}:</b><br>${alts.join('<br>') || '-'}</div>
  </div>`;
}
function challengeCard(idx,b){
  const altLabel = (arr) => (arr && arr.length === 1) ? 'Alternate' : 'Alternates';
  return `<article class="card">
    <div class="role">Player ${idx}</div>
    ${orderedBlock('Primary', b.primary)}
    ${orderedBlock('Sidearm', b.sidearm)}
    ${orderedBlock('Explosive', b.explosive)}
    <div class="kv"><b>Armor Weight</b><div>${escapeHtml(b.armor)}</div></div>
    ${orderedBlock('Booster', b.booster)}
    <div class="kv"><b>Stratagems (4 required)</b>
      <div>${escapeHtml((b.stratMain || []).join('\n')).replace(/\n/g,'<br>')}</div>
      <div class="small"><b>${altLabel(b.stratAlt || [])}:</b><br>
        ${escapeHtml((b.stratAlt || []).join('\n')).replace(/\n/g,'<br>') || '-'}</div>
    </div>
  </article>`;
}

document.addEventListener('click', (e)=>{
  if(e.target && e.target.id==='rollBtn'){
    if(!itemsReady){
      showError('Items are still loading. Please wait a second and try again.');
      return;
    }
    try{ renderChallenge(); }
    catch(err){ showError(err.message || String(err)); }
  }
});
function renderChallenge(){
  const n = parseInt($("#players").value,10);
  let fSel = $("#challengeFaction").value;
  let dSel = $("#challengeDifficulty").value;
  if(fSel==='Random'){ fSel = rand(ITEMS.factions); }
  if(dSel==='Random'){ dSel = rand(ITEMS.difficulties); }
  $("#challengeHeader").textContent = `${escapeHtml(fSel)} • ${escapeHtml(dSel)}`;
  const out = [];
  for(let p=1;p<=n;p++){ out.push(challengeCard(p, genPlayerBuild())); }
  $("#challengeResults").innerHTML = out.join('');
}

(function initCounter(){
  const NAMESPACE = 'mouthbreathertv-helldivers2';
  const KEY = 'site-visits';
  const ENDPOINT = 'https://api.countapi.xyz';
  const el = document.getElementById('visitCount');
  if (!el) return;

  const set = v => el.textContent = new Intl.NumberFormat().format(v ?? 0);

  async function ensure() {
  try {
    // try get first
    const g = await fetch(`${ENDPOINT}/get/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(KEY)}`);
    if (g.ok) {
      const d = await g.json();
      return d.value;
    }
    // if missing, create it at 0
    const c = await fetch(`${ENDPOINT}/create?namespace=${encodeURIComponent(NAMESPACE)}&key=${encodeURIComponent(KEY)}&value=0`);
    if (c.ok) {
      const d = await c.json();
      return d.value;
    }
  } catch (_) {}
  return 0;
}

  (async () => {
    const _ = await ensure();
    try {
      const h = await fetch(`${ENDPOINT}/hit/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(KEY)}`);
      if (h.ok) { const d = await h.json(); set(d.value); return; }
    } catch (_) {}
    // fallback to get if hit failed (adblock, etc.)
    try {
      const g = await fetch(`${ENDPOINT}/get/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(KEY)}`);
      if (g.ok) { const d = await g.json(); set(d.value); return; }
    } catch (_) {}
    set(0);
  })();
})();

function buildWhitelistFromItems(){
  WL.primaries  = buildSet(ITEMS.primaries);
  WL.sidearms   = buildSet(ITEMS.sidearms);
  WL.explosives = buildSet(ITEMS.explosives);
  WL.stratagems = buildSet([
    ...(ITEMS.stratagems?.turrets || []),
    ...(ITEMS.stratagems?.bombardment || []),
    ...(ITEMS.stratagems?.deployables || []),
  ]);
  itemsReady = true;
}

(function initHitsCounter(){
  function start(){
    const ID = 'mouthbreathertv-helldivers2'; // unique ID for your site
    const el = document.getElementById('visitCount');
    if (!el) return;

    const set = (n) => el.textContent = new Intl.NumberFormat().format(n ?? 0);

    fetch(`https://hits.sh/${encodeURIComponent(ID)}.json?view=1`, {
      cache: 'no-store',
      mode: 'cors',
    })
    .then(r => r.json())
    .then(d => set((d && typeof d.hits === 'number') ? d.hits : 0))
    .catch(err => {
      console.warn('hits.sh failed:', err);
      set(0);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();


load();
