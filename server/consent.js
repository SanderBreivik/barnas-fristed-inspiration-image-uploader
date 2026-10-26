// Consent texts. They are served to the form via GET /api/consent and stored
// verbatim with every submission. Change a text => bump CONSENT_VERSION.
import { env } from "./config.js";

export const CONSENT_TEXT =
  "Jeg bekrefter at jeg har rett til å dele bildet, og at jeg har " +
  "innhentet nødvendige tillatelser fra personer som kan gjenkjennes i det. " +
  "For bilder av barn bekrefter jeg at jeg er foresatt eller har foresattes " +
  "tillatelse. Jeg gir Barnas Fristed tillatelse til å publisere bildet, " +
  "og navn og beskrivelse hvis jeg har fylt dem ut, i inspirasjonsgalleriet " +
  "på barnasfristed.no. Bildet gjennomgås før publisering. Jeg kan når som " +
  "helst få bildet fjernet med slettelenken jeg får etter opplasting.";
export const MARKETING_TEXT =
  "Valgfritt: Jeg gir i tillegg Barnas Fristed tillatelse til å bruke bildet " +
  "i sosiale medier og annonser. Dette er ikke nødvendig for å delta i galleriet, " +
  "og jeg kan trekke samtykket tilbake ved å slette bildet.";
export const CONSENT_VERSION = env.CONSENT_VERSION || "2026-10-v2";
