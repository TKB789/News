// trends.mjs — runs in GitHub Actions. Fetches news-volume series from GDELT
// and commits them to data/trends/, so The Tally can read them same-origin.
// Browsers block the GDELT call cross-origin; Node does not care.
// No npm dependencies — Node's built-in fetch only.
import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';

const OUT   = 'data/trends';
const EXTRA = 'data/trends/terms.txt';   // optional: one term per line, edit on github.com
const START = '20170101000000';          // GDELT DOC API reaches back to 2017

// GDELT throttles hard. These numbers are the difference between 3 of 18
// landing and all 18 landing — do not lower them.
// GDELT throttles on a rolling window, so spacing matters far more than
// retrying. The gap adapts: it widens after every refusal and eases back
// after every success, settling near whatever rate GDELT will actually take.
const GAP_START  = 6000;
const GAP_MAX    = 30000;
const GAP_MIN    = 5000;
const RETRIES    = 2;                    // the next run picks up the rest
const BACKOFF_MS = [10000, 25000];
const TIMEOUT_MS = 45000;
const MAX_RUN_MS = 40 * 60 * 1000;       // stop and commit rather than run forever
const FRESH_MS   = 20 * 60 * 60 * 1000;  // a series younger than this can wait

// Terms kept permanently on file. Add here, or to data/trends/terms.txt.
const TERMS = [
  // storms & weather
  'hurricane', 'tropical storm', 'storm surge', 'typhoon', 'cyclone', 'tornado',
  'flooding', 'heat wave', 'blizzard',
  // earth & climate
  'wildfire', 'drought', 'earthquake', 'landslide', 'volcano',
  'sea level rise', 'deforestation', 'air pollution',
  // health
  'outbreak', 'epidemic', 'measles', 'dengue', 'cholera', 'malaria',
  'H5N1', 'avian influenza', 'polio', 'mpox', 'tuberculosis', 'antibiotic resistance',
  // war & security
  'war', 'ceasefire', 'airstrike', 'sanctions', 'refugees', 'coup',
  'terrorism', 'nuclear weapons', 'peace talks',
  // money & work
  'inflation', 'recession', 'unemployment', 'interest rates', 'tariffs',
  'layoffs', 'supply chain', 'food prices', 'debt crisis',
  // people & power
  'election', 'protest', 'strike', 'immigration', 'corruption',
  'censorship', 'press freedom', 'human rights',
  // technology
  'artificial intelligence', 'cyberattack', 'data breach', 'semiconductors',
  'surveillance', 'misinformation',
  // hardship
  'famine', 'displacement', 'evacuation', 'humanitarian crisis', 'poverty'
];

const slug  = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pad   = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = d => d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()) + '000000';

function loadExtraTerms(){
  if(!existsSync(EXTRA)) return [];
  try{
    return readFileSync(EXTRA, 'utf8')
      .split('\n')
      .map(l => l.replace(/#.*$/, '').trim())     // allow # comments
      .filter(Boolean);
  }catch{ return []; }
}

async function attempt(term){
  const q = /\s/.test(term) ? `"${term}"` : term;
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
    + '?query=' + encodeURIComponent(q)
    + '&mode=timelinevol&format=json'
    + '&startdatetime=' + START + '&enddatetime=' + stamp(new Date());

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let body;
  try{
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'QuietDeskTally/1.0 (+github pages)' }
    });
    if(res.status === 429) throw new Error('rate limited');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    body = await res.text();
  } finally { clearTimeout(timer); }

  // GDELT answers a throttled request with plain text, not JSON
  let json;
  try{ json = JSON.parse(body); }
  catch{ throw new Error('throttled or unparseable: ' + body.slice(0,90).replace(/\s+/g,' ')); }

  const raw = json?.timeline?.[0]?.data || [];
  if(!raw.length) throw new Error('empty timeline');

  const buckets = new Map();
  for(const p of raw){
    const s = String(p.date);
    const day = s.includes('-') ? s.slice(0,10)
      : s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
    const b = buckets.get(day) || [0,0];
    b[0] += Number(p.value) || 0; b[1]++;
    buckets.set(day, b);
  }
  return [...buckets.entries()]
    .map(([d,[sum,n]]) => ({ d, v: +(sum/n).toFixed(6) }))
    .sort((a,b) => a.d < b.d ? -1 : 1);
}

async function fetchSeries(term){
  let last;
  for(let i = 0; i < RETRIES; i++){
    try{
      return await attempt(term);
    }catch(e){
      last = e;
      if(i < RETRIES - 1){
        console.log(`  ${term}: ${e.message} — retrying in ${BACKOFF_MS[i]/1000}s`);
        await sleep(BACKOFF_MS[i]);
      }
    }
  }
  throw last;
}

// Rebuild data/trends/index.json from whatever files are actually on disk,
// so fetching a single term never drops the others from the list.
function buildIndex(){
  const terms = [];
  for(const f of readdirSync(OUT)){
    if(!f.endsWith('.json') || f === 'index.json') continue;
    try{
      const j = JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8'));
      if(j.term && j.pts?.length){
        terms.push({ term: j.term, slug: f.replace(/\.json$/, ''),
                     days: j.pts.length, fetched: j.fetched || 0 });
      }
    }catch{}
  }
  terms.sort((a,b) => a.term < b.term ? -1 : 1);
  writeFileSync(`${OUT}/index.json`,
    JSON.stringify({ updated: Date.now(), terms }, null, 0));
  return terms;
}

// Remember a one-off term so tomorrow's scheduled run keeps it current
function rememberTerm(term){
  const known = new Set([...TERMS, ...loadExtraTerms()].map(t => t.toLowerCase()));
  if(known.has(term.toLowerCase())) return false;
  if(!existsSync(EXTRA)) writeFileSync(EXTRA, '# One term per line. Added from the Actions tab.\n');
  appendFileSync(EXTRA, term + '\n');
  return true;
}

async function main(){
  if(!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const one = (process.env.TALLY_TERM || '').trim();
  const all = one ? [one] : [...new Set([...TERMS, ...loadExtraTerms()])];

  // What is already on disk, and how old is it?
  const age = new Map();
  for(const t of all){
    const f = `${OUT}/${slug(t)}.json`;
    if(!existsSync(f)) continue;
    try{
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if(j.pts?.length) age.set(t, j.fetched || 0);
    }catch{}
  }

  // Missing terms first, then the stalest. A partial run therefore always
  // makes progress on the gaps rather than re-fetching what already works.
  const queue = one ? [one] : all.slice().sort((a, b) => {
    const A = age.has(a) ? age.get(a) : -1;
    const B = age.has(b) ? age.get(b) : -1;
    return A - B;
  });

  const missing = queue.filter(t => !age.has(t)).length;
  console.log(`${all.length} terms total — ${age.size} on file, ${missing} missing.`);
  if(!one) console.log(`Fetching missing first, then the stalest.\n`);

  const began = Date.now();
  let gap = GAP_START;
  let ok = 0, kept = 0, lost = 0, skipped = 0, stopped = false;

  for(const term of queue){
    if(Date.now() - began > MAX_RUN_MS){
      stopped = true;
      console.log(`\nTime budget reached — committing what is done and stopping.`);
      break;
    }
    // leave recently-fetched series alone so the run spends its time on gaps
    if(!one && age.has(term) && Date.now() - age.get(term) < FRESH_MS){
      skipped++;
      continue;
    }

    const file = `${OUT}/${slug(term)}.json`;
    try{
      const pts = await fetchSeries(term);
      writeFileSync(file, JSON.stringify({ term, fetched: Date.now(), pts }, null, 0));
      ok++;
      gap = Math.max(GAP_MIN, Math.round(gap * 0.9));      // ease off
      console.log(`OK   ${term}: ${pts.length} days  (gap now ${Math.round(gap/1000)}s)`);
    }catch(e){
      gap = Math.min(GAP_MAX, Math.round(gap * 1.6));      // back away
      if(existsSync(file)){
        kept++;
        console.warn(`KEPT ${term}: ${e.message}  (gap now ${Math.round(gap/1000)}s)`);
      }else{
        lost++;
        console.warn(`MISS ${term}: ${e.message}  (gap now ${Math.round(gap/1000)}s)`);
      }
    }
    await sleep(gap);
  }

  if(one && ok){
    if(rememberTerm(one)) console.log(`Added "${one}" to ${EXTRA} so it stays current.`);
  }

  const onFile = buildIndex();
  const still  = all.filter(t => !onFile.some(o => o.term === t));

  console.log(`\nFetched ${ok}, kept ${kept}, failed ${lost}, skipped ${skipped} as still fresh.`);
  console.log(`${onFile.length} of ${all.length} terms now on file.`);
  if(still.length){
    console.log(`\nStill missing (${still.length}): ${still.join(', ')}`);
    console.log(`Run this workflow again — it fetches the gaps first, so a`);
    console.log(`second run is short and usually finishes them off.`);
  }
  if(stopped) console.log(`\nStopped on the time budget, not on an error.`);

  if(!onFile.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
