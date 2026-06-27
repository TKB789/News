// cleanup-once.mjs — ONE-TIME repair of already-archived day files.
// 1) Renames the "Good Developments" section to "Progress & Solutions".
// 2) Removes reports in that section that came from the general CSMonitor feed
//    (csmonitor.com) — the source that brought in hard news like the Iran strike.
// Everything else in every day is left untouched.
//
// Safe to run more than once (idempotent). Run it once, confirm, then you can delete this file.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const DATA_DIR = 'data';
const OLD_NAME = 'Good Developments';
const NEW_NAME = 'Progress & Solutions';
const NEW_LOOK = 'solutions journalism';
const REMOVE_SRC = 'csmonitor.com';   // domain to strip OUT of this section only

if (!existsSync(DATA_DIR)) { console.error('No data/ folder found.'); process.exit(1); }

let filesChanged = 0, itemsRemoved = 0, sectionsRenamed = 0;

for (const f of readdirSync(DATA_DIR)) {
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;   // only day files, skip index.json
  const path = `${DATA_DIR}/${f}`;
  let day;
  try { day = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  if (!day.cats) continue;

  let touched = false;

  for (const cat of day.cats) {
    if (cat.name !== OLD_NAME && cat.name !== NEW_NAME) continue;

    // remove CSMonitor-sourced items from this section
    const before = cat.items.length;
    cat.items = cat.items.filter(i => {
      const src = (i.src || '').toLowerCase();
      return !src.includes(REMOVE_SRC);
    });
    const removed = before - cat.items.length;
    if (removed > 0) { itemsRemoved += removed; touched = true; }

    // rename the section + tagline
    if (cat.name === OLD_NAME) { cat.name = NEW_NAME; sectionsRenamed++; touched = true; }
    if (cat.look !== NEW_LOOK) { cat.look = NEW_LOOK; touched = true; }

    // keep each item's internal cat label in sync
    cat.items.forEach(i => { if (i.cat === OLD_NAME) i.cat = NEW_NAME; });
  }

  if (touched) {
    writeFileSync(path, JSON.stringify(day, null, 0));
    filesChanged++;
    console.log(`Updated ${f}`);
  }
}

console.log(`\nDone. Files changed: ${filesChanged}, sections renamed: ${sectionsRenamed}, hard-news items removed: ${itemsRemoved}.`);
