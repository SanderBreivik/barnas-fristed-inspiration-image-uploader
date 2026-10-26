# Barnas Fristed – Inspirasjon (Fly.io-utgave)

Tilpasset `barnas-fristed.myshopify.com` og `https://barnasfristed.no`. Kodegrunnlag for anonym bildeopplasting, Pinterest-galleri, valgfri produktliste, samtykkelogging, slettelenke og modereringspanel.

**Status: utviklingsversjon, ikke produksjonsklar eller installert.** Syntaksen er kontrollert, men integrasjon, sikkerhet og deploy er ikke testet mot ekte Fly.io/Tigris/Shopify-kontoer.

## Installasjon

1. Opprett Fly.io-konto, installer `flyctl`, logg inn med `fly auth login`.
2. Opprett en Tigris-bucket (via Fly.io eller separat). Noter S3-endepunkt, bucket og tilgangsnøkler. Bucket skal være **privat**.
3. Endre `app` i `fly.toml` til et ledig navn. Kjør `fly launch --no-deploy` og kontroller konfigurasjonen.
4. Opprett SQLite-volume i valgt region: `fly volumes create inspiration_data --region arn --size 1` (velg størrelse etter behov).
5. Sett hemmeligheter: `fly secrets set PUBLIC_ORIGIN=https://DIN-APP.fly.dev TURNSTILE_SITE_KEY=... TURNSTILE_SECRET=... ADMIN_PASSWORD=... S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...`.
6. Lag Turnstile-widget med `barnasfristed.no` som tillatt hostname.
7. Kjør `fly deploy`. Test `https://DIN-APP.fly.dev/health`.
8. Shopify Admin → Nettbutikk → Sider → lag siden «Inspirasjon» med handle `inspirasjon`. Legg inn Custom Liquid via passende sidemal i temaredigereren og lim inn `shopify/inspirasjon.liquid`. Bytt `DIN-FLY-APP` med appens faktiske hostname.
9. Test med bilder uten personer først. Godkjenn via `https://DIN-APP.fly.dev/admin`.

## Før produksjon

- **Admin:** Adminpanelet er en separat passordbeskyttet side, ikke en embedded Shopify-admin-app. Legg identitetsbasert tilgang foran `/admin` og `/api/admin/*` (f.eks. autentiserende reverse proxy) og legg til innloggingsbeskyttelse/rate limiting.
- **Personvern:** Få juridisk vurdering av samtykke, lisens, retten til eget bilde, særlig bilder av barn, behandlingsgrunnlag, oppbevaring, sletting og databehandleravtaler. Samtykke til markedsføring er frivillig.
- **Slettelenker:** Innsenderen må selv lagre slettelenken; implementer e-postlevering eller alternativ verifisert sletting. Linken er en hemmelig tilgangsnøkkel.
- **Drift:** SQLite på ett Fly-volume er ikke automatisk HA; sett opp backup, restore-test og overvåking. Bruk kun én skrivende maskin.
- **Misbruk:** Legg på sterkere rate limiting, botbeskyttelse, bildeinnholdsmoderering og begrensninger på lagringsforbruk.
- **CORS:** Hvis Shopify videresender besøkende fra `www.barnasfristed.no`, må du håndtere dette domenet eksplisitt. Ikke bruk wildcard for innsending.
- **Produkttilknytning:** Shopify `/products.json` kan være begrenset; test med butikkens faktiske produkter.
- **Caching:** Bilder kan ligge i nettleser- og mellomlagringscache i inntil 60 sekunder etter sletting.
- **Ytterligere testing:** Kjør `npm install`, `npm run check`, funksjonelle tester, deploy-test og en fullstendig sikkerhetsgjennomgang før offentlig lansering.

## Samtykke og oppbevaring (UTKAST – krever eiers og juridisk vurdering)

Samtykketekstene ligger i `server/index.js` (`CONSENT_TEXT`, `MARKETING_TEXT`) og hentes av skjemaet via `GET /api/consent`, slik at skjema og logg alltid er identiske. Samtykkene er uavhengige: markedsføring er valgfritt og aldri en forutsetning for publisering. Ved hver innsending lagres nøyaktig tekst og versjon som ble vist. Endrer du teksten, **øk `CONSENT_VERSION`** (standard `2026-10-v2`; fjern en eventuell gammel `CONSENT_VERSION`-secret). Skjema med utdatert versjon avvises med 409.

Foreslått oppbevaring (må godkjennes). Automatisk håndhevelse er implementert, men **av som standard** (se «Automatisk opprydding» under):

| Data | Oppbevaring |
|---|---|
| Godkjente bilder | Til kunden sletter, eller til butikken avslutter galleriet |
| Ventende/avviste bilder | Foreslått maks 30 dager, deretter sletting |
| Slettede bilder | Fjernes umiddelbart fra galleri og lagring; DB beholder kun metadata |
| Samtykkelogg (`consent_events`, tekst, versjon, tidspunkt) | Foreslått 3 år som dokumentasjon, ingen bilder |
| Hash av slettetoken | Så lenge posten finnes |
| IP-hash for rate limit | Maks 1 time |

Bilder med barn og gjenkjennelige personer: innsender bekrefter tillatelse (foresatt for barn); moderator bør avvise bilder der barn kan identifiseres uten åpenbar tillatelse. Fjerning: via slettelenken (vises og kan kopieres etter opplasting). Lenken kan ikke gjenopprettes; kunder som mister den må kontakte butikken, som kan slette via `/admin`.

### Automatisk opprydding

- Ventende/avviste bilder eldre enn 30 dager utløper: avpubliseres, slettes fra lagring og får en `expired`-hendelse i samtykkeloggen.
- Navn og beskrivelse fjernes fra slettede rader etter 30 dager. Samtykkelogg for slettede bilder fjernes etter 3 år.
- **Forhåndsvisning (endrer ingenting):** logg inn på `/admin` og kall `POST /api/admin/maintenance/retention` (tom body). Svaret viser hvor mye som ville blitt ryddet. Med `{"apply":true}` utføres det.
- **Automatisk daglig kjøring** er av til du setter `fly secrets set RETENTION_ENABLED=true`. Gjør det først når perioden er godkjent. Verdier kan justeres med `RETENTION_PENDING_DAYS`, `RETENTION_SCRUB_DAYS` og `RETENTION_CONSENT_DAYS`.
- Maks 200 bilder per kjøring. Mislykket sletting fra lagring fullføres av «Fullfør ventende slettinger».
- Backuper (14 stk) kan inneholde data som allerede er ryddet bort, i opptil 14 dager.

## Backup og gjenoppretting

Lagringen har to deler, og begge må kunne gjenopprettes:

| Del | Beskyttelse | Oppbevaring |
|---|---|---|
| SQLite (`/data/photos.sqlite`) | 1) Daglig SQLite-konsistent kopi (online backup API), gzip, lastet opp til Tigris under `backups/`. 2) Siste kopi ligger også på volumet i `/data/backups/latest.sqlite.gz`. 3) Fly volume-snapshots (daglig, automatisk). | Appen beholder de **14** nyeste kopiene (`BACKUP_KEEP`). Snapshots: sett f.eks. 14 dager (kommando under). |
| Bilder (Tigris `photos/`) | Bildene er kun i Tigris. Bildene ligger i samme bucket som kopiene, så bucketen må ikke slettes. | Til kunden sletter bildet. |

Sikkerhetskopiene inneholder personopplysninger (visningsnavn, samtykkelogg, hash av slettetoken). Slettede bilders metadata kan derfor ligge i kopier i inntil 14 dager. Dette må stå i personvernerklæringen. Aktiver Tigris-versjonering **ikke** uten å vurdere dette, siden det beholder slettede bilder.

Kopien tas automatisk ca. hvert døgn (sjekkes hver time, så restart gir ikke duplikater). Slå av med `BACKUP_ENABLED=false`. Feil logges som `backup_failed` i `fly logs`.

Fly-snapshots (retention, PowerShell):

```powershell
fly volumes list --app barnas-fristed-inspirasjon
fly volumes update <volume-id> --snapshot-retention 14 --app barnas-fristed-inspirasjon
fly volumes snapshots list <volume-id>
```

### Ta og sjekke en backup

I `/admin` → **Vedlikehold** → *Ta sikkerhetskopi nå*. Hent siste kopi lokalt og verifiser den (påvirker ikke produksjon):

```powershell
fly ssh sftp get /data/backups/latest.sqlite.gz .\latest.sqlite.gz --app barnas-fristed-inspirasjon
node server/restore-check.js .\latest.sqlite.gz
```

Utskriften viser `ok: true`, antall bilder per status, antall samtykkehendelser og siste innsending. Avslutningskode ≠ 0 betyr at kopien ikke kan brukes. Slett den nedlastede filen etterpå (den inneholder personopplysninger).

> **Git Bash på Windows:** bash omskriver stier som starter med `/` (f.eks. `/data/...` blir `C:/Program Files/Git/data/...`) og tolker `\` som escape. Bruk PowerShell, eller i Git Bash: `MSYS_NO_PATHCONV=1 fly ssh sftp get /data/backups/latest.sqlite.gz ./latest.sqlite.gz --app barnas-fristed-inspirasjon` og `node server/restore-check.js ./latest.sqlite.gz` (skråstrek, ikke bakstrek).

### Gjenopprette databasen (tap av volum eller korrupt database)

1. Stopp skrivinger: `fly scale count 0 --app barnas-fristed-inspirasjon` (eller la appen stå hvis den ikke kjører).
2. Alternativ A, Fly-snapshot: `fly volumes create inspiration_data --snapshot-id <snapshot-id> --region arn --app barnas-fristed-inspirasjon`.
3. Alternativ B, appens kopi: verifiser filen med `node server/restore-check.js backup.sqlite.gz --to .\restored\photos.sqlite`, start deretter en maskin og kopier filen til `/data/photos.sqlite` med `fly ssh sftp shell`. Slett eventuelle gamle `photos.sqlite-wal`/`-shm`.
4. Start appen (`fly scale count 1`) og sjekk `/health` og `/admin`.
5. Kjør **Vedlikehold → Sjekk lagring mot database** og gå gjennom avviket under.

Hvis en kopi må hentes fra Tigris i stedet: filene ligger i bucketen under `backups/photos-ÅÅÅÅMMDDTTMMSSZ.sqlite.gz` (bruk Fly/Tigris-dashboardet eller en S3-klient).

### Avstemming mellom database og bilder

*Sjekk lagring mot database* (`GET /api/admin/maintenance/reconcile`) er kun lesing og rapporterer:

- `missingObjects`: databasen har en post, men bildet finnes ikke i Tigris. Bildet må hentes fra Tigris-bucket/annen kopi, ellers avvis/slett posten manuelt.
- `pendingDeletions`: kunden/admin har slettet, men objektet ligger igjen. *Fullfør ventende slettinger* sletter dem trygt (de er allerede avpublisert).
- `orphanObjects`: objekter uten databasepost (f.eks. mislykket opplasting). **Slettes ikke automatisk**; vurder manuelt og slett i Tigris hvis de ikke trengs. Etter en gjenoppretting kan nye bilder fra tiden etter siste kopi dukke opp her; slike mangler samtykkelogg og bør ikke publiseres.

### Test av gjenoppretting

Automatiske tester (`npm test`) tar en backup, verifiserer den med integritetssjekk, gjenoppretter til en ny database og kontrollerer innholdet. Gjør i tillegg en manuell øvelse etter første deploy og deretter ca. hver 3. måned: kommandoene under «Ta og sjekke en backup».

## Kodestruktur (`server/`)

| Fil | Ansvar |
|---|---|
| `index.js` | Setter sammen appen (middleware-rekkefølge), feilhåndtering, oppstart og avslutning |
| `config.js` | Miljøvariabler, påkrevde innstillinger, `num()` |
| `db.js`, `schema.sql` | SQLite og migreringer |
| `storage.js` | Tigris/S3 (`storage.put/get/del/list`, byttes ut i tester) |
| `origins.js` | CORS og opprinnelseskontroll |
| `auth.js` | Admin-innlogging, økter, CSRF |
| `turnstile.js`, `limits.js` | Bot-sjekk og rate limits |
| `consent.js` | Samtykketekster og versjon |
| `maintenance.js`, `jobs.js`, `restore-check.js` | Backup, gjenoppretting, opprydding, bakgrunnsjobber |
| `log.js` | JSON-logging uten hemmeligheter |
| `routes/public.js` | Health, config, samtykke, galleri, bilder |
| `routes/submit.js` | Opplasting |
| `routes/removal.js` | Kundens slettelenke |
| `routes/admin.js` | Moderering og vedlikehold |

## Tillatte opprinnelser (CORS)

Tillatt er `barnasfristed.no`, `www.barnasfristed.no`, `barnas-fristed.myshopify.com`, `SHOP_ORIGIN` og Shopifys forhåndsvisningsadresser (`https://<tilfeldig>.shopifypreview.com`, uten port eller underdomener), slik at temaeditor og forhåndsvisning fungerer uten oppsett. Andre jokertegn finnes ikke.

- Skru av forhåndsvisning: `fly secrets set ALLOW_SHOPIFY_PREVIEW=false`.
- Legg til en ekstra eksakt adresse: `fly secrets set EXTRA_ORIGINS="https://eksempel.no,https://annen.no"`.

## API

`GET /api/config`, `GET /api/gallery?page=0`, `GET /images/:id`, `POST /api/submit`, `POST /api/remove`, `GET /admin`, `GET /api/admin/photos`, `GET /api/admin/preview/:id`, `POST /api/admin/photos/:id/:action`.

## Overvåking og logging

- Alle logger er JSON-linjer (`fly logs --app barnas-fristed-inspirasjon`). Passord, tokens, cookies og bildedata blir aldri logget; IP og query-strenger logges ikke.
- `/health` er enkel liveness-sjekk (brukes av Fly). `/health/deep` sjekker database og lagring (200/503) – bruk den i en ekstern oppetidsmonitor (f.eks. UptimeRobot).
- Varsler sendes til en webhook (Slack/Discord) ved: `unclean_restart` (krasj/OOM), `memory_high`, `health_check_failed`, `backup_failed`, `storage_delete_failed`, `storage_put_failed`, `orphan_object`, `submit_failed`, `db_error`, `uncaught_exception`, `unhandled_rejection`. Maks ett varsel per hendelse per 15 min.
- Aktiver: `fly secrets set ALERT_WEBHOOK_URL="https://..." --app barnas-fristed-inspirasjon`
- En `metrics`-linje (minne, økter, hendelsestellere) logges hvert 5. minutt.
