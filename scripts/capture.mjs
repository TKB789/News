// capture.mjs — runs in GitHub Actions. Fetches RSS, dedupes against earlier
// days, writes data/YYYY-MM-DD.json and data/index.json. No browser, no relay,
// and NO npm dependencies (uses Node's built-in fetch + a small RSS parser).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';

const DAYS_KEPT = 60;     // how many daily snapshots to retain in the repo
const PER_CAT   = 0;      // max NEW items kept per category per day (0 = no cap, keep all)

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
    "https://aeon.co/feed.rss" ]},
  { name:"Good Developments", look:"progress, quietly", feeds:[
    "https://www.positive.news/feed/",
    "https://www.goodnewsnetwork.org/feed/",
    "https://reasonstobecheerful.world/feed/",
    "https://www.yesmagazine.org/feed",
    "https://rss.csmonitor.com/feeds/csm" ]},
  { name:"Arts & Culture", look:"human achievement", feeds:[
    "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
    "https://www.theguardian.com/culture/rss",
    "https://www.smithsonianmag.com/rss/arts-culture/",
    "https://www.theguardian.com/books/rss",
    "https://www.npr.org/rss/rss.php?id=1008",
    "https://theconversation.com/us/arts/articles.atom" ]},
  { name:"Climate & Environment", look:"both sides of the ledger", feeds:[
    "https://www.sciencedaily.com/rss/earth_climate.xml",
    "https://earth.org/feed/",
    "https://www.theguardian.com/environment/rss",
    "https://grist.org/feed/",
    "https://insideclimatenews.org/feed/",
    "https://theconversation.com/us/environment/articles.atom",
    "https://e360.yale.edu/feed.xml" ]},
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
  { name:"World & Conflict", look:"the harder current events", feeds:[
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://www.npr.org/rss/rss.php?id=1004",
    "https://www.france24.com/en/rss",
    "https://rss.dw.com/rdf/rss-en-world",
    "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
    "https://theconversation.com/us/world/articles.atom",
    "https://rss.csmonitor.com/feeds/world" ]},
  { name:"Economy & Markets", look:"the money underneath", feeds:[
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://www.theguardian.com/business/economics/rss",
    "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" ]},
  { name:"Business & Finance", look:"companies, deals, money", feeds:[
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://www.theguardian.com/uk/business/rss",
    "https://feeds.npr.org/1006/rss.xml" ]},
  { name:"Sports", look:"results and the human feats", feeds:[
    "https://feeds.bbci.co.uk/sport/rss.xml",
    "https://www.espn.com/espn/rss/news",
    "https://www.theguardian.com/sport/rss" ]},
  { name:"Humanitarian & Development", look:"crises, aid, and the long work", feeds:[
    "https://reliefweb.int/updates/rss.xml",
    "https://news.un.org/feed/subscribe/en/news/topic/humanitarian-aid/feed/rss.xml",
    "https://www.thenewhumanitarian.org/rss.xml",
    "https://www.devex.com/news.rss",
    "https://globalvoices.org/feed/" ]},
  { name:"Regional Spotlights", look:"under-covered corners", feeds:[
    "https://www.mercopress.com/rss/",
    "https://www.scmp.com/rss/91/feed",
    "https://www.africanews.com/feed/rss",
    "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
    "https://www.theguardian.com/world/africa/rss",
    "https://restofworld.org/feed/latest/" ]},
  { name:"Weather & Civil Alerts", look:"calm, not urgent", feeds:[
    "https://www.sciencedaily.com/rss/earth_climate/natural_disasters.xml",
    "https://gdacs.org/xml/rss.xml" ]}
];

const DATA_DIR = 'data';

function todayKey(){
  return new Date().toISOString().slice(0,10);   // UTC, stable for scheduled runs
}
function domain(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch{ return ''; } }

function decode(s){
  return (s||'')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/<[^>]*>/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'")
    .replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n))
    .replace(/\s+/g,' ').trim();
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
  return blocks.map(b=>{
    let link = decode(tag(b,'link')) || attrLink(b);
    link = (link||'').trim();
    const date = tag(b,'pubDate') || tag(b,'published') || tag(b,'updated') || tag(b,'dc:date');
    let iso=null; if(date){ const d=new Date(decode(date)); if(!isNaN(d)) iso=d.toISOString(); }
    return {
      title: decode(tag(b,'title')),
      link,
      blurb: decode(tag(b,'description') || tag(b,'summary') || tag(b,'content:encoded') || tag(b,'content')),
      date: iso,
      src: domain(link) || domain(feedUrl)
    };
  }).filter(i=>i.title);
}

async function fetchFeed(url){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 20000);
  try{
    const res = await fetch(url, { signal:ctrl.signal, headers:{ 'User-Agent':'QuietDeskBot/1.0 (+rss reader)' }});
    if(!res.ok) throw new Error('HTTP '+res.status);
    return parseFeed(await res.text(), url);
  } finally { clearTimeout(t); }
}

function loadEarlierLinks(tk){
  const set = new Set();
  if(!existsSync(DATA_DIR)) return set;
  for(const f of readdirSync(DATA_DIR)){
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if(!m || m[1] >= tk) continue;            // only days strictly before today
    try{
      const day = JSON.parse(readFileSync(`${DATA_DIR}/${f}`,'utf8'));
      day.cats.forEach(c=>c.items.forEach(i=>set.add(i.link||i.title)));
    }catch{}
  }
  return set;
}

async function main(){
  if(!existsSync(DATA_DIR)) mkdirSync(DATA_DIR,{recursive:true});
  const tk = todayKey();
  const before = loadEarlierLinks(tk);

  // start from whatever was already captured today (so multiple runs/day accumulate)
  let existing = { date:tk, built:0, cats:[] };
  if(existsSync(`${DATA_DIR}/${tk}.json`)){
    try{ existing = JSON.parse(readFileSync(`${DATA_DIR}/${tk}.json`,'utf8')); }catch{}
  }
  const todaySeen = new Set();
  existing.cats.forEach(c=>c.items.forEach(i=>todaySeen.add(i.link||i.title)));

  const cats = [];
  let ok=0, fail=0;
  for(const cat of CATEGORIES){
    const prior = existing.cats.find(c=>c.name===cat.name);
    const items = prior ? [...prior.items] : [];
    const localSeen = new Set(items.map(i=>i.link||i.title));
    const results = await Promise.allSettled(cat.feeds.map(fetchFeed));
    for(const r of results){
      if(r.status==='fulfilled'){ ok++;
        for(const it of r.value){
          const id = it.link||it.title;
          if(before.has(id)) continue;        // seen an earlier day → not new
          if(localSeen.has(id)) continue;     // already in today's snapshot
          localSeen.add(id); items.push(it);
        }
      } else fail++;
    }
    items.sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
    const kept = PER_CAT > 0 ? items.slice(0,PER_CAT) : items;
    cats.push({ name:cat.name, look:cat.look, items: kept.map(i=>({...i,cat:cat.name})) });
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
