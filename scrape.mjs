// Hämtar kommande friidrottstävlingar från EasyRecord och Webathletics
// och skriver data.json som sidan (index.html) läser.
// INTEGRITET: inga personuppgifter sparas. För varje gren sparas bara antal anmälda
// och en sorterad lista med anmälda PB (utan namn, klubb eller födelseår).
// Körs varje natt av .github/workflows/update.yml. Kan också köras lokalt: npm install && node scrape.mjs
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-roten = mappen där index.html ligger
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = [HERE, process.cwd(), path.resolve(HERE, '..')].find(d => fsSync.existsSync(path.join(d, 'index.html'))) || HERE;
const OUT = path.join(ROOT, 'data.json');
const ER = 'https://easyrecord.se';
const WA_API = 'https://wapublicapi.webathletics.se';
const UA = 'Friidrottskartan/1.0 (daglig sammanställning av kommande tävlingar)';
const DELAY_MS = 300; // var snäll mot servrarna

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());

async function get(url, asJson = false) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'sv', Cookie: 'lang=sv' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} för ${url}`);
      const body = asJson ? await r.json() : await r.text();
      await sleep(DELAY_MS);
      return body;
    } catch (e) { lastErr = e; await sleep(2000 * (i + 1)); }
  }
  throw lastErr;
}

/* ---------- normalisering av grenar, klasser och resultat ---------- */
const FIELD = ['Höjd', 'Stav', 'Längd', 'Tresteg', 'Kula', 'Diskus', 'Spjut', 'Slägga', 'Viktkastning', 'Boll'];
const DRE = /((?<![\d\p{L}])(?:\d{1,2}\s[05]00|\d{2,5})\s?m(?:\s?häck|\s?hinder|\s?gång)?(?![\p{L}])|1 timme|höjd|stav|längd|tresteg|kula|diskus|spjut|slägga|vikt(?:kastning)?|boll)/iu;

export function splitEvent(n) {
  if (/kamp|prova på|4x|stafett/i.test(n)) return null; // mångkamp och stafett jämförs inte
  const m = n.match(DRE);
  if (!m) return null;
  let d = m[1].replace(/\s+/g, ' ').trim();
  let cls = n.slice(0, m.index).replace(/[-&]/g, ' ').replace(/\s+/g, ' ').trim();
  const dm = d.match(/^(\d{1,2}\s[05]00|\d{2,5})\s?m(?:\s?(häck|hinder|gång))?$/i);
  if (dm) {
    let num = dm[1].replace(/\s/g, '');
    num = num.length > 3 ? num.slice(0, -3) + ' ' + num.slice(-3) : num;
    d = num + ' m' + (dm[2] ? ' ' + dm[2].toLowerCase() : '');
  } else {
    d = d[0].toUpperCase() + d.slice(1).toLowerCase();
    if (d.startsWith('Vikt')) d = 'Viktkastning';
  }
  if (/^kvinnor$/i.test(cls)) cls = 'K';
  if (/^män$/i.test(cls)) cls = 'M';
  cls = cls.replace(/^([A-ZÅÄÖ]+)\s+(\d+)$/, '$1$2');
  if (!cls) cls = 'Öppen';
  return [cls, d];
}
const isField = d => FIELD.includes(d) || d === '1 timme';

// EasyRecord visar t.ex. "9.51", "2:15.32", "261" (cm i höjd/stav), "4.65" (m)
export function erMark(s, d) {
  if (!s) return 0;
  s = s.replace(',', '.').trim();
  if (d === 'Höjd' || d === 'Stav') return +(parseFloat(s) / 100).toFixed(2) || 0;
  if (isField(d)) return parseFloat(s) || 0;
  const p = s.split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return +p.reduce((a, x) => a * 60 + x, 0).toFixed(2);
}

// En gren = [klass, gren, datum, antal anmälda, sorterade PB (bäst först)]
function anonEvent(cls, disc, date, marks) {
  const pb = marks.filter(v => v > 0).sort((a, b) => isField(disc) ? b - a : a - b);
  return [cls, disc, date, marks.length, pb];
}

/* ---------- EasyRecord ---------- */
export function parseErIndex(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.competition-wrapper[data-date-state="2"]').each((_, w) => {
    const $w = $(w); const v = $w.find('.venue').first();
    out.push({
      id: $w.attr('data-competition-code'), name: ($w.attr('data-competition-name') || '').trim(),
      city: $w.attr('data-competition-city') || '', loc: (v.attr('data-name') || '').trim(),
      lat: parseFloat(v.attr('data-latitude')), lng: parseFloat(v.attr('data-longitude')),
      indoor: /Inomhus/.test($w.text()) ? 1 : 0,
    });
  });
  return out;
}
export function parseErInfo(html) {
  const $ = cheerio.load(html);
  $('script,style').remove();
  const t = $('body').text().replace(/\u00a0/g, ' ');
  const m = t.match(/Datum:\s*(\d{4}-\d{2}-\d{2})(?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/);
  const a = t.match(/Arrangör:\s*([^\n]+)/);
  const r = t.match(/Ordinarie anmälan:\s*(\d{4}-\d{2}-\d{2})/);
  return { d1: m?.[1], d2: m?.[2] || m?.[1], host: a ? a[1].replace(/Tävlingsledare.*/, '').trim() : '', regClose: r?.[1] || '' };
}
export function parseErStartlist(html) {
  const $ = cheerio.load(html);
  const evs = [];
  $('.startlist-event').each((_, e) => {
    const name = $(e).find('h4').first().text().trim();
    const rows = []; // bara PB-texten per anmäld, inga namn
    $(e).find('tbody tr').each((_, tr) => {
      const $tr = $(tr);
      if (!$tr.find('td.participantName').text().trim()) return;
      rows.push($tr.find('td.pb').first().contents().first().text().trim());
    });
    if (rows.length) evs.push([name, rows]);
  });
  return evs;
}
async function scrapeEasyRecord() {
  const list = parseErIndex(await get(ER + '/'));
  console.log(`EasyRecord: ${list.length} kommande tävlingar`);
  const comps = [];
  for (const c of list) {
    try {
      Object.assign(c, parseErInfo(await get(`${ER}/info?c=${c.id}`)));
      const evs = parseErStartlist(await get(`${ER}/startlist?c=${c.id}`));
      c.e = [];
      for (const [n, rows] of evs) {
        const sp = splitEvent(n); if (!sp) continue;
        c.e.push(anonEvent(sp[0], sp[1], '', rows.map(r => erMark(r, sp[1]))));
      }
    } catch (err) { console.warn(`  varning ${c.id} ${c.name}: ${err.message}`); c.e = c.e || []; }
    if (!c.d1) { console.warn(`  hoppar över ${c.id} (saknar datum)`); continue; }
    comps.push({ s: 'er', id: c.id, n: c.name, c: c.city, v: c.loc, la: c.lat, lo: c.lng, d1: c.d1, d2: c.d2, h: c.host, i: c.indoor, r: c.regClose, ro: '', e: c.e });
  }
  return comps;
}

/* ---------- Webathletics (öppet JSON-gränssnitt) ---------- */
async function scrapeWebathletics(cityCoords, venues) {
  const all = await get(`${WA_API}/competitions?historyDays=30`, true);
  const up = all.filter(c => c.last_date >= today && !c.test && c.publish !== 0 && (!c.country || c.country === 'Sverige'));
  console.log(`Webathletics: ${up.length} kommande tävlingar`);
  const comps = [];
  for (const c of up) {
    let e = [];
    try {
      const evs = await get(`${WA_API}/entrylistbyevent/${c.competitionID}`, true);
      for (const ev of evs) {
        if (ev.is_relay || ev.eventtype === 4 || !ev.entrants?.length) continue; // 4 = mångkamp
        const sp = splitEvent(ev.eventname); if (!sp) continue;
        const marks = ev.entrants.filter(a => !a.declined).map(a => a.PB ? +(a.PB / 100).toFixed(2) : 0);
        if (marks.length) e.push(anonEvent(sp[0], sp[1], ev.sdate && !(c.first_date === c.last_date) ? ev.sdate : '', marks));
      }
    } catch (err) { console.warn(`  varning wa ${c.competitionID} ${c.name}: ${err.message}`); }
    const loc = (c.location || '').trim();
    const vk = Object.keys(venues).find(k => k.toLowerCase() === loc.toLowerCase());
    let la, lo, ap = 0;
    if (vk) [la, lo] = venues[vk];
    else if (cityCoords[c.city]) { [la, lo] = cityCoords[c.city]; ap = 1; }
    else { console.warn(`  okänd ort "${c.city}" för ${c.name} – lägg till i venues.json`); continue; }
    comps.push({ s: 'wa', id: String(c.competitionID), n: (c.name || '').trim(), c: c.city, v: loc, la, lo, ...(ap ? { ap: 1 } : {}),
      d1: c.first_date, d2: c.last_date, h: c.host || '', i: c.indoor ? 1 : 0, r: c.reg_close || '', ro: c.reg_open || '', e });
  }
  return comps;
}

/* ---------- huvudprogram ---------- */
async function main() {
  const findFile = name => [path.join(ROOT, name), path.join(ROOT, 'scripts', name)].find(f => fsSync.existsSync(f));
  const citiesPath = findFile('cities.json');
  if (!citiesPath) throw new Error('Hittar inte cities.json bredvid index.html.');
  const cities = JSON.parse(await fs.readFile(citiesPath, 'utf8'));
  const venuesPath = findFile('venues.json');
  const venues = venuesPath ? JSON.parse(await fs.readFile(venuesPath, 'utf8')) : {};
  const cityCoords = Object.fromEntries(cities.map(c => [c[0], [c[1], c[2]]]));

  const results = await Promise.allSettled([scrapeEasyRecord(), scrapeWebathletics(cityCoords, venues)]);
  let old = null; try { old = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}
  const parts = results.map((r, i) => {
    if (r.status === 'fulfilled' && r.value.length) return r.value;
    const src = i === 0 ? 'er' : 'wa';
    console.warn(`${src === 'er' ? 'EasyRecord' : 'Webathletics'} misslyckades (${r.reason?.message || 'inga tävlingar'}) – behåller gårdagens data för den källan`);
    // gammal data i det anonyma formatet (ev[3] är ett antal). Äldre format med namn kastas.
    return (old?.comps || []).filter(c => c.s === src && c.d2 >= today).map(c => ({ ...c, e: c.e.filter(ev => typeof ev[3] === 'number') }));
  });
  const comps = parts.flat();
  if (results.every(r => r.status === 'rejected')) throw new Error('Båda källorna misslyckades – data.json lämnas orörd.');
  if (comps.length < 3) throw new Error(`Bara ${comps.length} tävlingar hittades – troligen har en sida ändrat utseende. data.json lämnas orörd.`);

  comps.sort((a, b) => a.d1.localeCompare(b.d1) || a.n.localeCompare(b.n, 'sv'));
  const names = new Set(cities.map(c => c[0]));
  for (const c of comps) if (!names.has(c.c)) { cities.push([c.c, +c.la.toFixed(3), +c.lo.toFixed(3)]); names.add(c.c); }

  const data = { updated: today, comps, cities };
  await fs.writeFile(OUT, JSON.stringify(data));
  const ents = comps.reduce((n, c) => n + c.e.reduce((m, e) => m + e[3], 0), 0);
  console.log(`Klart: ${comps.length} tävlingar, ${ents} anmälningar → data.json (${today})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
export { main };
