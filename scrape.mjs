// Hämtar kommande friidrottstävlingar från EasyRecord, Webathletics, Track & Field (trackandfield.se) och Roster Athletics
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


// Ortnamn från källan -> koordinater. Exakt, sedan skiftlägesokänsligt, sedan första kända ord i texten.
function makeCityResolver(cityCoords) {
  const lc = new Map(Object.entries(cityCoords).map(([k, v]) => [k.toLowerCase(), [k, v]]));
  return (...texts) => {
    for (const t of texts) {
      if (!t) continue;
      const s = String(t).trim();
      if (cityCoords[s]) return [s, cityCoords[s]];
      const hit = lc.get(s.toLowerCase()); if (hit) return hit;
      for (const w of s.split(/[\s,\/()-]+/)) { const h = lc.get(w.toLowerCase()); if (h && w.length > 2) return h; }
    }
    return null;
  };
}

/* ---------- Track & Field (trackandfield.se, Swedish Timing) ---------- */
const TF = 'https://www.trackandfield.se';
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const isIndoorVenue = v => /hall|hus|arena|inomhus|indoor|dome|kupol/i.test(v || '');

// "Första Chansen 14-15 nov 2026", "Göteborgs inomhus 29-31 jan 2027", "IVSM 30 jan - 1 feb 2027"
export function parseTfTitle(s) {
  s = s.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  let m = s.match(/^(.*?)\s+(\d{1,2})\s*([a-zåäö]{3})?\s*-\s*(\d{1,2})\s+([a-zåäö]{3})\w*\s+(\d{4})$/i);
  if (m) {
    const y = +m[6], m2 = MON[m[5].toLowerCase()], m1 = m[3] ? MON[m[3].toLowerCase()] : m2;
    const y1 = m1 > m2 ? y - 1 : y;
    return { name: m[1].trim(), d1: `${y1}-${pad(m1)}-${pad(+m[2])}`, d2: `${y}-${pad(m2)}-${pad(+m[4])}` };
  }
  m = s.match(/^(.*?)\s+(\d{1,2})\s+([a-zåäö]{3})\w*\s+(\d{4})$/i);
  if (m) { const d = `${m[4]}-${pad(MON[m[3].toLowerCase()])}-${pad(+m[2])}`; return { name: m[1].trim(), d1: d, d2: d }; }
  return null;
}
// T&F skriver längre lopp som "2.43" (= 2:43) eller "2:54.79"
export function tfMark(s, d) {
  if (!s) return 0;
  s = s.replace(',', '.').trim();
  if (isField(d)) return parseFloat(s) || 0;
  if (s.includes(':')) return erMark(s, d);
  const v = parseFloat(s); if (!v) return 0;
  const dist = parseInt(d, 10) * (/\d\s\d{3}/.test(d) ? 1000 : 1) || parseInt(d.replace(/\s/g, ''), 10);
  if (dist >= 300 && v < 15) { const min = Math.floor(v); return +(min * 60 + Math.round((v - min) * 100)).toFixed(2); }
  return v;
}
export function parseTfIndex(html) {
  const $ = cheerio.load(html);
  const ids = [];
  // bara korten under "Kommande tävlingar"
  $('a[href*="Competition?comp="]').each((_, a) => {
    if ($(a).find('.upcoming-banner').length === 0) return;
    const id = ($(a).attr('href').match(/comp=(\d+)/) || [])[1];
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids;
}
export function parseTfInfo(html) {
  const $ = cheerio.load(html); $('script,style').remove();
  const t = $('body').text().replace(/\u00a0/g, ' ');
  const g = re => { const m = t.match(re); return m ? m[1].trim() : ''; };
  return { city: g(/Ort:\s*([^\n]+)/), venue: g(/Arena:\s*([^\n]+)/), host: g(/Arrangör:\s*([^\n]*)/).replace(/^Kontakt.*$/, ''), nation: g(/Nation:\s*([A-Z]{3})/), reg: g(/Anmäl senast:\s*([^\n]+)/) };
}
export function parseTfEntries(html) {
  const $ = cheerio.load(html); const evs = [];
  $('.event-block').each((_, b) => {
    const name = ($(b).attr('data-event') || $(b).find('.search-eventname').text()).trim();
    const pbs = []; $(b).find('tr.participant-row').each((_, tr) => pbs.push($(tr).find('td.col-pb .stat-main').first().text().trim()));
    if (pbs.length) evs.push([name, pbs]);
  });
  return evs;
}
async function scrapeTrackAndField(cityCoords) {
  const resolve = makeCityResolver(cityCoords);
  const ids = parseTfIndex(await get(TF + '/'));
  console.log(`Track & Field: ${ids.length} kommande tävlingar`);
  const comps = [];
  for (const id of ids) {
    try {
      const $ = cheerio.load(await get(`${TF}/Home/Competition?comp=${id}`));
      const head = parseTfTitle($('.page-title h5').first().text() || $('h5').first().text());
      if (!head || head.d2 < today) continue;
      const info = parseTfInfo(await get(`${TF}/CompInfo?comp=${id}`));
      if (info.nation && info.nation !== 'SWE') continue;
      let r = '';
      const rm = info.reg.match(/(\d{1,2})\s+([a-zåäö]{3})/i);
      if (rm) { const mo = MON[rm[2].toLowerCase()]; const y = +head.d1.slice(0, 4) - (mo > +head.d1.slice(5, 7) ? 1 : 0); r = `${y}-${pad(mo)}-${pad(+rm[1])}`; }
      const e = [];
      for (const [n, pbs] of parseTfEntries(await get(`${TF}/Entries/LoadClassEvents?compId=${id}`))) {
        const sp = splitEvent(n); if (!sp) continue;
        e.push(anonEvent(sp[0], sp[1], '', pbs.map(p => tfMark(p, sp[1]))));
      }
      const hit = resolve(info.city, info.venue, head.name);
      if (!hit) { console.warn(`  T&F: okänd ort "${info.city}" för ${head.name}`); continue; }
      const [city, cc] = hit;
      comps.push({ s: 'tf', id, n: head.name, c: city, v: info.venue, la: cc[0], lo: cc[1], ap: 1, d1: head.d1, d2: head.d2, h: info.host, i: isIndoorVenue(info.venue) ? 1 : 0, r, ro: '', e });
    } catch (err) { console.warn(`  varning T&F ${id}: ${err.message}`); }
  }
  return comps;
}

/* ---------- Roster Athletics (öppet JSON-gränssnitt) ---------- */
const RO = 'https://api.meets.rosterathletics.com/api/public';
const RO_EVENTS = [[/^(\d+)m Hurdles$/i, m => fmtDist(m[1]) + ' häck'], [/^(\d+)m Steeplechase$/i, m => fmtDist(m[1]) + ' hinder'], [/^(\d+)m Race ?Walk$/i, m => fmtDist(m[1]) + ' gång'], [/^(\d+)m$/i, m => fmtDist(m[1])],
  [/^High Jump/i, () => 'Höjd'], [/^Pole Vault/i, () => 'Stav'], [/^Long Jump/i, () => 'Längd'], [/^Triple Jump/i, () => 'Tresteg'], [/^Shot Put/i, () => 'Kula'], [/^Discus/i, () => 'Diskus'], [/^Javelin/i, () => 'Spjut'], [/^Hammer/i, () => 'Slägga'], [/^Weight Throw/i, () => 'Viktkastning'], [/^Ball Throw/i, () => 'Boll']];
function fmtDist(n) { n = String(n); return (n.length > 3 ? n.slice(0, -3) + ' ' + n.slice(-3) : n) + ' m'; }
export function roDisc(name) { for (const [re, f] of RO_EVENTS) { const m = name.match(re); if (m) return f(m); } return null; }
async function post(url, body) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status} för ${url}`);
      const j = await r.json(); await sleep(DELAY_MS); return j;
    } catch (e) { if (i === 2) throw e; await sleep(2000 * (i + 1)); }
  }
}
async function scrapeRoster(cityCoords) {
  const resolve = makeCityResolver(cityCoords);
  const meets = [];
  let body = { tz: 'Europe/Stockholm', tzMinutes: 60, countryCode: 'SWE', first: true, afterFilter: today };
  for (let page = 0; page < 10; page++) { // max 10 sidor
    const j = await post(`${RO}/meeting/search/v2`, body);
    meets.push(...(j.meets || []));
    if (!(j.after > 0) || !j.meets?.length) break;
    const last = j.meets[j.meets.length - 1];
    body = { ...body, first: null, after: last.startDateTime, afterId: last.meetingId };
  }
  console.log(`Roster Athletics: ${meets.length} kommande tävlingar`);
  const comps = [];
  for (const m of meets) {
    try {
      if (m.restricted) continue;
      const d = await get(`${RO}/meeting/${m.meetingId}/details`, true);
      const se = Object.fromEntries((d.sportEvents || []).map(x => [x.eventIdPk, x]));
      const ag = Object.fromEntries((d.ageGroups || []).map(x => [x.ageGroupIdPk, x]));
      const sch = await get(`${RO}/meeting/${m.meetingId}/schedule`, true);
      const groups = new Map(); // "klass|gren" -> Map(athleteId -> pb)
      for (const { entityDto: ev } of sch.data || []) {
        if (!ev?.hasParticipants) continue;
        const s = se[ev.eventIdFk]; if (!s || s.relay || s.combined) continue;
        const disc = roDisc(s.eventName); if (!disc) continue;
        const res = await get(`${RO}/meeting/${m.meetingId}/results-v2/${ev.meetingEventIdPk}`, true);
        const gender = Object.fromEntries((res.athleteList || []).map(a => [a.athleteIdPk, a.gender]));
        const a = ag[ev.ageGroupIdFk] || {};
        for (const { entityDto: p } of res.mpList || []) {
          if (!p || p.startStatus === 'Scratched' || p.startStatus === 'DNS') continue;
          const g = ev.gender === 'Mixed' ? gender[p.athleteIdFk] : ev.gender;
          let cls;
          if (a.category === 'Meeting' && a.rangeStart > 0 && a.rangeStart === a.rangeEnd) cls = (g === 'Female' ? 'F' : 'P') + a.rangeStart;
          else if (/vet/i.test(ev.label || '')) cls = g === 'Female' ? 'Veteraner Kvinnor' : 'Veteraner Män';
          else if (/^[FPKM]\d{0,2}$/.test(a.name || '')) cls = a.name;
          else cls = g === 'Female' ? 'K' : 'M';
          const raw = p.initialPersonalBest;
          const pb = raw ? (s.resultType === 'Duration' ? +(raw / 10000).toFixed(2) : +(raw / 100).toFixed(2)) : 0;
          const key = cls + '|' + disc;
          if (!groups.has(key)) groups.set(key, new Map());
          const gm = groups.get(key); if (!gm.has(p.athleteIdFk) || (pb && !gm.get(p.athleteIdFk))) gm.set(p.athleteIdFk, pb);
        }
      }
      const e = [...groups].map(([k, gm]) => { const [cls, disc] = k.split('|'); return anonEvent(cls, disc, '', [...gm.values()]); });
      const lat = +(d.address?.latitude ?? d.latitude ?? m.latitude), lng = +(d.address?.longitude ?? d.longitude ?? m.longitude);
      const hit = resolve(d.address?.city, m.city, d.address?.venueName || m.venueName, m.meetingName);
      let city, la, lo, ap = 1;
      if (hit) { city = hit[0]; [la, lo] = hit[1]; }
      else if (lat > 55 && lat < 70 && lng > 10 && lng < 25) { city = d.address?.city || m.city || 'Okänd ort'; la = lat; lo = lng; ap = 0; }
      else { console.warn(`  Roster: okänd ort "${d.address?.city || m.city}" för ${m.meetingName}`); continue; }
      if (hit && lat > 55 && lat < 70 && lng > 10 && lng < 25) { la = lat; lo = lng; ap = 0; }
      comps.push({ s: 'ro', id: String(m.meetingId), n: (m.meetingName || '').trim(), c: city, v: d.address?.venueName || m.venueName || '', la, lo, ap,
        d1: m.startDateTime.slice(0, 10), d2: (m.endDateTime || m.startDateTime).slice(0, 10), h: d.organiserDisplayName || d.organiserName || '',
        i: d.season === 'Indoor' ? 1 : 0, r: (d.registrationDeadline || m.registrationDeadline || '').slice(0, 10), ro: '', e });
    } catch (err) { console.warn(`  varning Roster ${m.meetingId}: ${err.message}`); }
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

  const SOURCES = [['er', 'EasyRecord'], ['wa', 'Webathletics'], ['tf', 'Track & Field'], ['ro', 'Roster Athletics']];
  const results = await Promise.allSettled([scrapeEasyRecord(), scrapeWebathletics(cityCoords, venues), scrapeTrackAndField(cityCoords), scrapeRoster(cityCoords)]);
  let old = null; try { old = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}
  const parts = results.map((r, i) => {
    if (r.status === 'fulfilled' && r.value.length) return r.value;
    const [src, label] = SOURCES[i];
    console.warn(`${label} misslyckades (${r.reason?.message || 'inga tävlingar'}) – behåller gårdagens data för den källan`);
    // gammal data i det anonyma formatet (ev[3] är ett antal). Äldre format med namn kastas.
    return (old?.comps || []).filter(c => c.s === src && c.d2 >= today).map(c => ({ ...c, e: c.e.filter(ev => typeof ev[3] === 'number') }));
  });
  // samma tävling kan finnas på två plattformar: behåll den med flest anmälda
  const seen = new Map();
  for (const c of parts.flat()) {
    const k = c.n.toLowerCase().replace(/[^a-zåäö0-9]/g, '') + '|' + c.d1 + '|' + c.c.toLowerCase();
    const n = c.e.reduce((s, e) => s + e[3], 0);
    if (!seen.has(k) || n > seen.get(k).n) seen.set(k, { c, n });
  }
  const comps = [...seen.values()].map(x => x.c);
  if (results.slice(0, 2).every(r => r.status === 'rejected')) throw new Error('Både EasyRecord och Webathletics misslyckades – data.json lämnas orörd.');
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
