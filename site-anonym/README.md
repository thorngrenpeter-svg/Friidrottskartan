# Friidrottskartan

Alla kommande friidrottstävlingar i Sverige (från EasyRecord och Webathletics) på en karta, med jämförelse av ditt PB mot de anmälda – utan att visa några namn.

- `index.html` – sidan · `integritet.html` – integritetstext
- `data.json` – tävlingar, antal anmälda och anonyma PB-listor. Skrivs om varje natt.
- `scrape.mjs` – hämtar datan. `cities.json` – orter. `venues.json` – valfria exakta arenapositioner.
- `.github/workflows/update.yml` – kör hämtningen varje natt.
- `CNAME` – kopplar sidan till www.friidrottskartan.se.
- Typsnitt (`*.woff2`) och `d3.min.js` ligger här så att besökare inte skickas vidare till Google eller andra tjänster.

Inga namn, klubbar eller födelseår sparas – bara antal anmälda och sorterade PB per klass och gren.
