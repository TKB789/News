// trends.mjs — runs in GitHub Actions. Fetches news-volume series from GDELT
// and commits them to data/trends/, so The Tally can read them same-origin.
// Browsers block the GDELT call cross-origin; Node does not care.
// No npm dependencies — Node's built-in fetch only.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';

const OUT = 'data/trends';
const START = '20170101000000';          // GDELT DOC API reaches back to 2017
const GAP_MS = 1500;                     // be polite between calls

// Terms kept permanently on file. The standing watch on the page, plus the
// rising-now scan. Add anything here and it is fetched from the next run on.
const TERMS = [
  'hurricane', 'tropical storm', 'storm surge', 'flooding', 'wildfire',
  'heat wave', 'earthquake', 'drought',
  'outbreak', 'measles', 'dengue', 'cholera', 'H5N1', 'norovirus',
  'malaria', 'polio', 'mpox', 'avian influenza'
];

const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pad = n => String(n).padStart(2, '0');
function stamp(d){ return d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+'000000'; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchSeries(term){
  const q = /\s/.test(term) ? `"${term}"` : term;
  const end = stamp(new Date());
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
    + '?query=' + encodeURIComponent(q)
    + '&mode=timelinevol&format=json'
    + '&startdatetime=' + START + '&enddatetime=' + end;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let body;
  try{
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'QuietDeskTally/1.0 (+github pages)' }
    });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    body = await res.text();
  } finally { clearTimeout(timer); }

  // GDELT sometimes answers 200 with a plain-text complaint instead of JSON
  let json;
  try{ json = JSON.parse(body); }
  catch{ throw new Error('non-JSON reply: ' + body.slice(0, 120).replace(/\s+/g, ' ')); }

  const raw = json?.timeline?.[0]?.data || [];
  if(!raw.length) throw new Error('empty timeline');

  // collapse to one value per day
  const buckets = new Map();
  for(const p of raw){
    const s = String(p.date);
    const day = s.includes('-')
      ? s.slice(0, 10)
      : s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    const b = buckets.get(day) || [0, 0];
    b[0] += Number(p.value) || 0; b[1]++;
    buckets.set(day, b);
  }
  return [...buckets.entries()]
    .map(([d, [sum, n]]) => ({ d, v: +(sum / n).toFixed(6) }))
    .sort((a, b) => a.d < b.d ? -1 : 1);
}

async function main(){
  if(!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  let ok = 0, failed = 0;
  const manifest = [];

  for(const term of TERMS){
    const file = `${OUT}/${slug(term)}.json`;
    try{
      const pts = await fetchSeries(term);
      writeFileSync(file, JSON.stringify({ term, fetched: Date.now(), pts }, null, 0));
      manifest.push({ term, slug: slug(term), days: pts.length });
      ok++;
      console.log(`${term}: ${pts.length} days`);
    }catch(e){
      failed++;
      console.warn(`${term}: ${e.message}`);
      // keep whatever was committed on an earlier run rather than dropping it
      if(existsSync(file)){
        try{
          const old = JSON.parse(readFileSync(file, 'utf8'));
          manifest.push({ term, slug: slug(term), days: old.pts?.length || 0, stale: true });
        }catch{}
      }
    }
    await sleep(GAP_MS);
  }

  writeFileSync(`${OUT}/index.json`,
    JSON.stringify({ updated: Date.now(), terms: manifest }, null, 0));
  console.log(`Trends: ${ok} fetched, ${failed} failed, ${manifest.length} on file.`);

  if(ok === 0) process.exit(1);   // surface a total outage in the Actions log
}

main().catch(e => { console.error(e); process.exit(1); });
