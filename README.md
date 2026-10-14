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

## API

`GET /api/config`, `GET /api/gallery?page=0`, `GET /images/:id`, `POST /api/submit`, `POST /api/remove`, `GET /admin`, `GET /api/admin/photos`, `GET /api/admin/preview/:id`, `POST /api/admin/photos/:id/:action`.
