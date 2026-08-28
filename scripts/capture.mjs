// capture.mjs — runs in GitHub Actions. Fetches RSS, dedupes against earlier
// days, writes data/YYYY-MM-DD.json and data/index.json. No browser, no relay,
// and NO npm dependencies (uses Node's built-in fetch + a small RSS parser).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';

const DAYS_KEPT = 60;     // how many daily snapshots to retain in the repo
const PER_CAT   = 0;      // max NEW items kept per category per day (0 = no cap, keep all)

// ---- topic blocklist: items whose title or blurb match are never kept ----
// (also scrubbed retroactively from existing snapshots on each run)
const EXCLUDE = [
  /\bastrolog/i,          // astrology, astrological, astrologer
  /\bhoroscope/i,
  /\bzodiac\b/i,
  /free will astrology/i,
  /\btarot\b/i,
  /^green (notification|earthquake|forest fire|flood|cyclone|volcano|drought|tsunami|landslide)\b/i,   // GDACS lowest-severity tier
];
function excluded(it){
  return EXCLUDE.some(re => re.test(it.title || '') || re.test(it.blurb || ''));
}

// ---- per-category blocklist: subjects to keep OUT of specific sections ----
// (they still appear in other categories where they're on-topic)
const CAT_EXCLUDE = {
  "Progress & Solutions": [
    /jeff bezos/i,
    /\bamazon\b(?!\s+(rain\s?forest|river|basin|jungle))/i,  // company, not the rainforest
  ],
  // "Arts & Culture": [ /.../i ],   // add more sections/patterns as needed
};
function catExcluded(catName, it){
  const list = CAT_EXCLUDE[catName];
  if(!list) return false;
  return list.some(re => re.test(it.title || '') || re.test(it.blurb || ''));
}

// ---- corroboration: cluster near-identical headlines across outlets ----
// Items get a `srcs` count (distinct outlets reporting the same story).
// Categories with minSrc > 1 drop stories below that count. Items dropped
// today are re-evaluated on later runs, so a story that gains a second
// outlet reappears automatically.
const SIM_RATIO  = 0.5;   // fraction of the shorter title's keywords that must match
const SIM_SHARED = 3;     // and at least this many keywords in common
const STOPWORDS = new Set(('the a an and or of to in on for with at by from as is are was were be been '+
  'it its this that these those after amid over under new says say said will has have had not but what '+
  'how why when where who more most than then his her their our your you can could may might just about').split(' '));
function keywords(title){
  return new Set((title||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ')
    .split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w))
    .map(w => w.replace(/([^s])s$/, '$1')));   // light stemming: cuts→cut, rates→rate
}
function similar(a,b){
  const [small,big] = a.size <= b.size ? [a,b] : [b,a];
  if(small.size === 0) return false;
  let shared = 0; for(const w of small) if(big.has(w)) shared++;
  return shared >= SIM_SHARED && shared / small.size >= SIM_RATIO;
}

// ---- your sources, grouped by category (edit freely) ----
const CATEGORIES = [
  { name:"Sky & Space", look:"events you can still catch", feeds:[
    "https://www.nasa.gov/feed/",
    "https://www.sciencedaily.com/rss/space_time.xml",
    "https://www.space.com/feeds/all",
    "https://earthsky.org/feed/",
    "https://skyandtelescope.org/feed/",
    "https://www.universetoday.com/feed/",
    "https://www.esa.int/rssfeed/TopNews",
    "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
    "https://www.spaceweather.com/spaceweather.xml",
    "https://www.nasa.gov/rss/dyn/lg_image_of_the_day.rss",
    "https://www.jpl.nasa.gov/feeds/news/",
    "https://api.quantamagazine.org/feed/" ]},
  { name:"Science & Medicine", look:"discoveries that help people", feeds:[
    "https://www.sciencedaily.com/rss/top/science.xml",
    "https://www.sciencedaily.com/rss/health_medicine.xml",
    "https://www.nature.com/nature.rss",
    "https://phys.org/rss-feed/",
    "https://www.eurekalert.org/rss/breaking.xml",
    "https://www.science.org/rss/news_current.xml",
    "https://www.newscientist.com/feed/home/",
    "https://www.nature.com/nm.rss",
    "https://connect.biorxiv.org/biorxiv_xml.php?subject=all",
    "https://theconversation.com/us/science/articles.atom",
    "https://aeon.co/feed.rss",
    "https://knowablemagazine.org/rss",
    "https://nautil.us/feed/" ]},
  { name:"Progress & Solutions", look:"solutions journalism", feeds:[
    "https://www.positive.news/feed/",
    "https://reasonstobecheerful.world/feed/",
    "https://www.yesmagazine.org/feed",
    "https://fixthenews.com/rss/",
    "https://ourworldindata.org/atom.xml",
    "https://www.vox.com/rss/future-perfect/index.xml",
    "https://squirrel-news.net/feed/",
    "https://www.optimistdaily.com/feed/",
    "https://worksinprogress.co/feed/" ]},
  { name:"Arts & Culture", look:"human achievement", feeds:[
    "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
    "https://www.theguardian.com/culture/rss",
    "https://www.smithsonianmag.com/rss/arts-culture/",
    "https://www.theguardian.com/books/rss",
    "https://www.npr.org/rss/rss.php?id=1008",
    "https://theconversation.com/us/arts/articles.atom",
    "https://www.themarginalian.org/feed/" ]},
  { name:"Climate & Environment", look:"both sides of the ledger", feeds:[
    "https://www.sciencedaily.com/rss/earth_climate.xml",
    "https://earth.org/feed/",
    "https://www.theguardian.com/environment/rss",
    "https://grist.org/feed/",
    "https://insideclimatenews.org/feed/",
    "https://theconversation.com/us/environment/articles.atom",
    "https://e360.yale.edu/feed.xml",
    "https://hakaimagazine.com/feed/" ]},
  { name:"Global Health", look:"outbreaks & public health", feeds:[
    "https://www.who.int/feeds/entity/mediacentre/news/en/rss.xml",
    "https://www.sciencedaily.com/rss/health_medicine/infectious_diseases.xml",
    "https://www.statnews.com/feed/",
    "https://feeds.bbci.co.uk/news/health/rss.xml",
    "https://www.thelancet.com/rssfeed/lancet_online.xml",
    "https://www.cidrap.umn.edu/news/rss.xml" ]},
  { name:"Technology", look:"how the tools are changing", feeds:[
    "https://www.theverge.com/rss/index.xml",
    "https://arstechnica.com/feed/",
    "https://www.wired.com/feed/rss",
    "https://feeds.bbci.co.uk/news/technology/rss.xml",
    "https://www.technologyreview.com/feed/",
    "https://restofworld.org/feed/latest/" ]},
  // minSrc:2 wants a second outlet before a story runs here. That rule is right
  // for rumour, wrong for scoops — an investigative piece is single-source by
  // definition. minSrcExempt lets named outlets through on their own.
  { name:"World & Conflict", minSrc:2,
    minSrcExempt:[/propublica\.org/i, /theintercept\.com/i, /un\.org/i, /theconversation\.com/i],
    look:"the harder current events", feeds:[
    "https://www.allsides.com/rss/news",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://www.npr.org/rss/rss.php?id=1004",
    "https://www.france24.com/en/rss",
    "https://rss.dw.com/rdf/rss-en-world",
    "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
    "https://theconversation.com/us/world/articles.atom",
    "https://rss.csmonitor.com/feeds/world",
    "https://www.propublica.org/feeds/propublica/main",
    "https://theintercept.com/feed/?rss" ]},
  { name:"Business & Economy", look:"companies, markets, the money underneath", feeds:[
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://www.theguardian.com/business/economics/rss",
    "https://www.theguardian.com/uk/business/rss",
    "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
    "https://feeds.npr.org/1006/rss.xml" ]},
  { name:"Sports", look:"results and the human feats", feeds:[
    "https://feeds.bbci.co.uk/sport/rss.xml",
    "https://www.espn.com/espn/rss/news",
    "https://www.theguardian.com/sport/rss" ]},
  { name:"Humanitarian & Development", look:"crises, aid, and the long work", feeds:[
    "https://reliefweb.int/updates/rss.xml",
    "https://news.un.org/feed/subscribe/en/news/topic/humanitarian-aid/feed/rss.xml",
    "https://www.thenewhumanitarian.org/rss.xml",
    "https://www.scidev.net/global/feed/",
    "https://www.devex.com/news.rss",
    "https://globalvoices.org/feed/" ]},
  { name:"Regional Spotlights", look:"under-covered corners", feeds:[
    "https://www.mercopress.com/rss/",
    "https://thebetterindia.com/feed/",
    "https://www.scmp.com/rss/91/feed",
    "https://www.africanews.com/feed/rss",
    "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
    "https://www.theguardian.com/world/africa/rss",
    "https://restofworld.org/feed/latest/" ]},
  { name:"Weather & Civil Alerts", look:"calm, not urgent", feeds:[
    "https://www.sciencedaily.com/rss/earth_climate/natural_disasters.xml",
    "https://gdacs.org/xml/rss.xml" ]},
  // Domestic politics had no section at all before now: legislatures, courts,
  // elections and executive action only turned up when a world desk covered
  // them. Delete or trim this block freely if it isn't your patch.
  { name:"Politics & Power", look:"legislatures, courts, elections", feeds:[
    "https://feeds.npr.org/1014/rss.xml",
    "https://www.theguardian.com/us-news/us-politics/rss",
    "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
    "https://feeds.bbci.co.uk/news/politics/rss.xml",
    "https://www.theguardian.com/politics/rss",
    "https://rss.politico.com/politics-news.xml",
    "https://thehill.com/news/feed/",
    "https://www.scotusblog.com/feed/",
    "https://www.euractiv.com/feed/" ]},
  // Runs last on purpose: every category above claims a story first, so this
  // section ends up holding what the rest of the paper missed rather than
  // repeating it.
  { name:"Crowdsourced", look:"what readers pushed to the top", feeds:[
    "https://www.reddit.com/r/worldnews/.rss?limit=50",
    "https://www.reddit.com/r/news/.rss?limit=50",
    "https://www.reddit.com/r/inthenews/.rss?limit=50",
    "https://www.reddit.com/r/geopolitics/.rss?limit=50",
    "https://www.reddit.com/r/UpliftingNews/.rss?limit=50" ]}
];

const DATA_DIR = 'data';

function todayKey(){
  return new Date().toISOString().slice(0,10);   // UTC, stable for scheduled runs
}
function domain(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return ''; } }

// ---- link normalisation ----
// Two outlets' feeds often hand out the same article with different tracking
// junk on the end. Stripping it makes the "have I already seen this?" check
// actually work, and lets a Reddit submission match the original article.
const TRACK = /^(utm_|at_|cmp$|ito$|ns_|ocid$|smid$|ref$|ref_src$|fbclid$|gclid$|mc_cid$|mc_eid$|s_cid$|__twitter_impression$|guccounter$)/i;
function normLink(u){
  if(!u) return '';
  try{
    const url = new URL(u);
    url.hash = '';
    url.protocol = 'https:';
    url.hostname = url.hostname.replace(/^www\./,'').toLowerCase();
    for(const k of [...url.searchParams.keys()]) if(TRACK.test(k)) url.searchParams.delete(k);
    let s = url.toString().replace(/\/$/,'');
    return s;
  }catch{ return String(u).trim(); }
}
// the identity used for de-duplication everywhere
function idOf(it){ return normLink(it.link) || (it.title||'').toLowerCase().trim(); }

// ---- Reddit ----
// Reddit's feeds are Atom, and a link post's <link> points at the comment
// thread, not the article. The real URL is buried in the escaped HTML of
// <content> as an anchor labelled [link]. We pull it out so the item is
// credited to the outlet that actually reported it — which also means it
// de-dupes against the same story arriving through a normal feed, and counts
// properly in the corroboration pass instead of inflating reddit.com.
function isReddit(u){ return /(^|\.)reddit\.com/i.test(domain(u)); }
function unescapeEntities(s){
  return (s||'')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)))
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&amp;/g,'&');
}
function subredditOf(block, feedUrl){
  const m = block.match(/<category[^>]*\blabel=["']([^"']+)["']/i);
  if(m) return decode(m[1]);
  const f = (feedUrl||'').match(/\/r\/([A-Za-z0-9_]+)/);
  return f ? 'r/'+f[1] : 'reddit';
}
function parseRedditEntry(block, feedUrl){
  const permalink = (block.match(/<link[^>]*\shref=["']([^"']+)["']/i)||[])[1] || '';
  const html = unescapeEntities(tag(block,'content') || tag(block,'summary'));
  // the submitted URL, i.e. the anchor whose text is [link]
  const linkAnchor = html.match(/<a\s+href=["']([^"']+)["'][^>]*>\s*\[link\]\s*<\/a>/i);
  // hrefs come through double-escaped (&amp;amp;) — unescape once more
  const outboundRaw = linkAnchor ? unescapeEntities(linkAnchor[1]).trim() : '';
  const outbound = outboundRaw && !isReddit(outboundRaw) ? outboundRaw : '';
  // self-post body: everything inside the md div, minus the submitted-by tail
  let body = (html.match(/<div class=["']md["']>([\s\S]*?)<\/div>/i)||[])[1] || '';
  body = cleanBlurb(body).replace(/\s*submitted by\s*\/u\/\S+\s*$/i,'').trim();
  const link = outbound || permalink;
  const sub  = subredditOf(block, feedUrl);
  const date = tag(block,'published') || tag(block,'updated');
  let iso=null; if(date){ const d=new Date(decode(date)); if(!isNaN(d)) iso=d.toISOString(); }
  return {
    title: decode(tag(block,'title')),
    link,
    blurb: body,
    date: iso,
    src: outbound ? domain(outbound) : 'reddit.com',
    via: sub,                 // shown in the byline as "via r/worldnews"
    discuss: permalink        // link to the thread itself
  };
}

function decode(s){
  return (s||'')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/<[^>]*>/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'")
    .replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n))
    .replace(/\s+/g,' ').trim();
}
function cleanBlurb(s){
  let t=decode(s);
  // strip publisher "read more" tails and trailing ellipses
  t=t.replace(/\s*(\[\s*&#8230;\s*\]|\[\s*…\s*\])\s*$/,'');         // [།] / [...]
  t=t.replace(/\s*(read more|continue reading|read full story|the post .* appeared first on .*)\s*$/i,'');
  t=t.replace(/\s*(\.{2,}|\u2026)\s*$/,'');                         // trailing ... or … only (keep single .)
  t=t.replace(/\s*[–—-]\s*$/,'');                                    // dangling dash
  return t.trim();
}
function tag(block, name){
  // grabs <name ...>...</name> (first match), CDATA-aware
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re); return m ? m[1] : '';
}
function attrLink(block){
  // Atom <link href="..."/>
  const m = block.match(/<link[^>]*\shref=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function parseFeed(xml, feedUrl){
  // split into <item> or <entry> blocks
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  if(isReddit(feedUrl)) return blocks.map(b=>parseRedditEntry(b, feedUrl)).filter(i=>i.title);
  return blocks.map(b=>{
    let link = decode(tag(b,'link')) || attrLink(b);
    link = (link||'').trim();
    const date = tag(b,'pubDate') || tag(b,'published') || tag(b,'updated') || tag(b,'dc:date');
    let iso=null; if(date){ const d=new Date(decode(date)); if(!isNaN(d)) iso=d.toISOString(); }
    return {
      title: decode(tag(b,'title')),
      link,
      blurb: cleanBlurb(tag(b,'description') || tag(b,'summary') || tag(b,'content:encoded') || tag(b,'content')),
      date: iso,
      src: domain(link) || domain(feedUrl)
    };
  }).filter(i=>i.title);
}

async function fetchOnce(url){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 20000);
  try{
    const res = await fetch(url, { signal:ctrl.signal, headers:{
      'User-Agent':'QuietDeskBot/1.0 (+rss reader; contact via repo issues)',
      'Accept':'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8'
    }});
    if(!res.ok) throw new Error('HTTP '+res.status);
    return parseFeed(await res.text(), url);
  } finally { clearTimeout(t); }
}
// Reddit rate-limits and sometimes 403s requests from cloud IP ranges, which is
// what GitHub Actions runs on. If www fails we retry the old.reddit mirror once
// before giving up, and the failure is named in the log either way.
function mirrors(url){
  if(isReddit(url) && /\/\/www\.reddit\.com/i.test(url)) return [url, url.replace('//www.reddit.com','//old.reddit.com')];
  return [url];
}
async function fetchFeed(url){
  let last;
  for(const u of mirrors(url)){
    try{ return await fetchOnce(u); }catch(e){ last = e; }
  }
  throw new Error(`${url} → ${last && last.message}`);
}

function loadEarlierLinks(tk){
  const set = new Set();
  if(!existsSync(DATA_DIR)) return set;
  for(const f of readdirSync(DATA_DIR)){
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if(!m || m[1] >= tk) continue;            // only days strictly before today
    try{
      const day = JSON.parse(readFileSync(`${DATA_DIR}/${f}`,'utf8'));
      day.cats.forEach(c=>c.items.forEach(i=>set.add(idOf(i))));
    }catch{}
  }
  return set;
}

function scrubSnapshots(){
  // retroactively remove blocklisted items from already-captured days
  if(!existsSync(DATA_DIR)) return;
  for(const f of readdirSync(DATA_DIR)){
    if(!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    try{
      const day = JSON.parse(readFileSync(`${DATA_DIR}/${f}`,'utf8'));
      let removed = 0;
      const seen = new Set();
      for(const c of day.cats){
        const n = c.items.length;
        c.items = c.items.filter(i => {
          if(excluded(i) || catExcluded(c.name, i)) return false;
          const id = idOf(i);
          if(seen.has(id)) return false;   // duplicate from another category
          seen.add(id);
          return true;
        });
        removed += n - c.items.length;
      }
      if(removed){
        writeFileSync(`${DATA_DIR}/${f}`, JSON.stringify(day, null, 0));
        console.log(`Scrubbed ${removed} blocklisted item(s) from ${f}`);
      }
    }catch{}
  }
}

async function main(){
  if(!existsSync(DATA_DIR)) mkdirSync(DATA_DIR,{recursive:true});
  scrubSnapshots();
  const tk = todayKey();
  const before = loadEarlierLinks(tk);

  // start from whatever was already captured today (so multiple runs/day accumulate)
  let existing = { date:tk, built:0, cats:[] };
  if(existsSync(`${DATA_DIR}/${tk}.json`)){
    try{ existing = JSON.parse(readFileSync(`${DATA_DIR}/${tk}.json`,'utf8')); }catch{}
  }
  const todaySeen = new Set();
  existing.cats.forEach(c=>c.items.forEach(i=>todaySeen.add(idOf(i))));

  const cats = [];
  let ok=0, fail=0;
  for(const cat of CATEGORIES){
    const prior = existing.cats.find(c=>c.name===cat.name);
    const items = prior ? [...prior.items] : [];
    // dedupe across ALL categories, not just this one (first category wins)
    const localSeen = todaySeen;
    items.forEach(i=>localSeen.add(idOf(i)));
    const results = await Promise.allSettled(cat.feeds.map(fetchFeed));
    for(const r of results){
      if(r.status==='fulfilled'){ ok++;
        for(const it of r.value){
          const id = idOf(it);
          if(excluded(it)) continue;               // blocklisted topic (global)
          if(catExcluded(cat.name, it)) continue;  // blocklisted for this section
          if(before.has(id)) continue;        // seen an earlier day → not new
          if(localSeen.has(id)) continue;     // already in today's snapshot
          localSeen.add(id); items.push(it);
        }
      } else { fail++; console.log(`  feed failed → ${r.reason && r.reason.message}`); }
    }
    items.sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
    const kept = PER_CAT > 0 ? items.slice(0,PER_CAT) : items;
    cats.push({ name:cat.name, look:cat.look, items: kept.map(i=>({...i,cat:cat.name})) });
  }

  // ---- corroboration pass: annotate every item with a distinct-source count ----
  {
    const all = cats.flatMap(c => c.items);
    const keys = all.map(i => keywords(i.title));
    // inverted index so we only compare pairs that share at least one keyword
    const byWord = new Map();
    keys.forEach((k, idx) => { for(const w of k){ if(!byWord.has(w)) byWord.set(w, []); byWord.get(w).push(idx); } });
    const parent = all.map((_, i) => i);
    const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (a,b) => { a = find(a); b = find(b); if(a !== b) parent[a] = b; };
    const tried = new Set();
    keys.forEach((k, a) => {
      for(const w of k) for(const b of byWord.get(w)){
        if(b <= a) continue;
        const pair = a * all.length + b;
        if(tried.has(pair)) continue; tried.add(pair);
        if(all[a].src !== all[b].src && similar(keys[a], keys[b])) union(a, b);
      }
    });
    const clusterSrcs = new Map();
    all.forEach((it, i) => {
      const r = find(i);
      if(!clusterSrcs.has(r)) clusterSrcs.set(r, new Set());
      clusterSrcs.get(r).add(it.src);
    });
    all.forEach((it, i) => { it.srcs = clusterSrcs.get(find(i)).size; });
    // per-category minimum-source filter
    for(const c of cats){
      const def = CATEGORIES.find(k => k.name === c.name);
      const min = def?.minSrc || 1;
      const exempt = def?.minSrcExempt || [];
      if(min > 1){
        const n = c.items.length;
        c.items = c.items.filter(i => i.srcs >= min || exempt.some(re => re.test(i.link||'') || re.test(i.src||'')));
        if(n - c.items.length) console.log(`${c.name}: held back ${n - c.items.length} single-source item(s).`);
      }
    }
  }

  writeFileSync(`${DATA_DIR}/${tk}.json`, JSON.stringify({ date:tk, built:Date.now(), cats }, null, 0));
  console.log(`Captured ${tk}: ${ok} feeds ok, ${fail} failed, ${cats.reduce((s,c)=>s+c.items.length,0)} new items total.`);

  // rebuild index + prune old snapshots
  let days = readdirSync(DATA_DIR).map(f=>f.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean).sort();
  const keep = days.slice(-DAYS_KEPT);
  for(const d of days){ if(!keep.includes(d)){ try{ rmSync(`${DATA_DIR}/${d}.json`); }catch{} } }
  writeFileSync(`${DATA_DIR}/index.json`, JSON.stringify({ days: keep, updated: Date.now() }, null, 0));
  console.log(`Index written: ${keep.length} days retained.`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
