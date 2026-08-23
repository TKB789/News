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
const GAP_MS     = 6000;                 // between terms
const RETRIES    = 3;                    // attempts per term
const BACKOFF_MS = [8000, 20000, 45000]; // wait before each retry
const TIMEOUT_MS = 45000;

// Terms kept permanently on file. Add here, or to data/trends/terms.txt.
const TERMS = [
  'hurricane', 'tropical storm', 'storm surge', 'typhoon', 'cyclone',
  'flooding', 'wildfire', 'heat wave', 'earthquake', 'drought', 'landslide',
  'outbreak', 'epidemic', 'measles', 'dengue', 'cholera', 'malaria',
  'H5N1', 'avian influenza', 'norovirus', 'polio', 'mpox', 'tuberculosis',
  'famine', 'displacement', 'evacuation'
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
  const terms = one
    ? [one]
    : [...new Set([...TERMS, ...loadExtraTerms()])];

  if(one) console.log(`Adding a single term: "${one}"\n`);
  else    console.log(`${terms.length} terms to fetch.\n`);

  let ok = 0, kept = 0, lost = 0;
  const manifest = [];

  for(const term of terms){
    const file = `${OUT}/${slug(term)}.json`;
    try{
      const pts = await fetchSeries(term);
      writeFileSync(file, JSON.stringify({ term, fetched: Date.now(), pts }, null, 0));
      manifest.push({ term, slug: slug(term), days: pts.length });
      ok++;
      console.log(`✓ ${term}: ${pts.length} days`);
    }catch(e){
      // keep whatever an earlier run committed rather than dropping the term
      if(existsSync(file)){
        try{
          const old = JSON.parse(readFileSync(file, 'utf8'));
          manifest.push({ term, slug: slug(term), days: old.pts?.length || 0, stale: true });
          kept++;
          console.warn(`· ${term}: ${e.message} — keeping the copy on file`);
        }catch{ lost++; console.warn(`✗ ${term}: ${e.message}`); }
      }else{
        lost++;
        console.warn(`✗ ${term}: ${e.message}`);
      }
    }
    if(terms.length > 1) await sleep(GAP_MS);
  }

  if(one && ok) {
    if(rememberTerm(one)) console.log(`Added "${one}" to ${EXTRA} so it stays current.`);
  }

  const onFile = buildIndex();
  console.log(`\nFetched ${ok}, kept ${kept} from earlier runs, missing ${lost}.`);
  console.log(`${onFile.length} terms now on file: ${onFile.map(t => t.term).join(', ')}`);

  // Fail the run only if nothing at all is on file, so a partial
  // throttle does not turn the Actions tab red every morning.
  if(!onFile.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
