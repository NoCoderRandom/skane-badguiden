import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = resolve(root, "data.json");
const previousPath = resolve(root, "map-data.json");
const outputPath = resolve(root, "map-data.json");
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const IMAGE_SEARCH_VERSION = 7;
const COMMONS_EXACT_RADIUS_METERS = 350;
const COMMONS_FALLBACK_RADIUS_METERS = 1800;
const COMMONS_LIMIT = 20;
const COMMONS_DELAY_MS = 900;
const IMAGE_BATCH_SIZE = 3;
const CHECKPOINT_EVERY = 15;
const EMPTY_IMAGE_RECHECK_DAYS = 30;
const FILLED_IMAGE_RECHECK_DAYS = 180;
let commonsRateLimited = false;
let commonsRequestQueue = Promise.resolve();
let lastCommonsRequestAt = 0;

const GENERIC_BEACH_WORDS = new Set([
  "bad", "badet", "badplats", "badplatsen", "badhus", "brygga", "bryggan",
  "camping", "havsbad", "hamn", "hamnen", "norra", "sodra", "strand",
  "stranden", "ostra", "vastra"
]);
const AMBIGUOUS_UNLOCATED_BEACHES = new Set([
  "kallsjon", "lilleskog", "tallbacken", "viks fiskelage", "vastersjon"
]);
const IRRELEVANT_WORDS = /kettlebell|museum|kyrka|church|school|skola|exhibition|utstallning|monument|minneskors|memorial|helikopter|helicopter|busshallplats|bus stop|tegelbruk|vattentorn|water tower|fabriksbyggnad|factory|bruksomrade|camera lens|canon ef|ponnyridning|restaurang|restaurant|hotell|hotel|horsal|hamntorg|pumphus|mandrup|somateria|thalasseus|seal|klocka|bell|malning|painting|aftenstemning|scout|wikivoyage banner|bassang|rasthaus|skepparpsgarden/i;

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function compactText(value, max = 900) {
  return stripTags(value).slice(0, max);
}

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("sv-SE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function beachNameTokens(beach) {
  return normalizeText(beach.name)
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !GENERIC_BEACH_WORDS.has(word));
}

function titleStem(value) {
  return normalizeText(String(value || "").replace(/\.[a-z0-9]{2,5}$/i, ""));
}

function sceneMatch(value) {
  return normalizeText(value).split(/\s+/).some((word) => (
    /strand|beach|brygg|pier|jetty|coast|kust|havsbad|hamn|harbour|harbor|haven|sunset|sunrise|seascape|wave|oresund|skaldervik|shore|klipp/.test(word)
    || /sjon$/.test(word)
    || /^(hav|sjo|lake|sea|sand|badstrand|badbild|badliv|badplats)$/.test(word)
  ));
}

function nameEvidence(title, beach) {
  const normalizedTitle = normalizeText(title);
  const tokens = beachNameTokens(beach);
  const matchedTokens = tokens.filter((token) => normalizedTitle.includes(token));
  const longestTokenLength = Math.max(0, ...tokens.map((token) => token.length));
  const primaryMatch = matchedTokens.some((token) => token.length === longestTokenLength);
  const normalizedName = normalizeText(beach.name);
  const normalizedMunicipality = normalizeText(beach.municipality);
  return {
    tokens,
    matchedTokens,
    nameMatches: matchedTokens.length,
    primaryMatch,
    exactTitle: titleStem(title) === normalizedName,
    exactPrimaryTitle: matchedTokens.some((token) => titleStem(title) === token),
    municipalityMatch: normalizedMunicipality.length >= 4 && normalizedTitle.includes(normalizedMunicipality)
  };
}

function reliableNameMatch(title, beach, distanceMeters) {
  const evidence = nameEvidence(title, beach);
  if (!evidence.nameMatches || !evidence.primaryMatch) return false;
  if (Number.isFinite(distanceMeters)) return distanceMeters <= COMMONS_FALLBACK_RADIUS_METERS;
  if (AMBIGUOUS_UNLOCATED_BEACHES.has(normalizeText(beach.name)) && !evidence.municipalityMatch) return false;
  return sceneMatch(title)
    || evidence.exactTitle
    || evidence.exactPrimaryTitle
    || evidence.municipalityMatch
    || evidence.tokens.length > 1 && evidence.nameMatches === evidence.tokens.length;
}

function uniqueTextParts(parts) {
  const unique = [];
  for (const part of parts.map(stripTags).filter(Boolean)) {
    const normalized = part.toLowerCase().replace(/\s+/g, " ").trim();
    const existingIndex = unique.findIndex((item) => (
      item.normalized === normalized
      || item.normalized.includes(normalized)
      || normalized.includes(item.normalized)
    ));
    if (existingIndex === -1) {
      unique.push({ text: part, normalized });
    } else if (normalized.length > unique[existingIndex].normalized.length) {
      unique[existingIndex] = { text: part, normalized };
    }
  }
  return unique.map((item) => item.text);
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function qualityText(beach) {
  if (toArray(beach.advice).length) return "Avrådan";
  const latest = beach.latestResult?.sampleAssessIdText;
  if (latest) return latest;
  return beach.profile?.lastFourClassifications?.[0]?.qualityClassIdText || "Uppgift saknas";
}

function serviceTags(beach) {
  const text = [
    beach.description,
    beach.profile?.summary,
    beach.profile?.bathingWater?.description
  ].filter(Boolean).join(" ").toLowerCase();
  const tags = new Set();
  if (/toalett|wc|dass/.test(text)) tags.add("Toalett");
  if (/kiosk/.test(text)) tags.add("Kiosk");
  if (/restaurang|café|cafe|servering|glass/.test(text)) tags.add("Restaurang");
  if (/brygga|badbrygga|badstege/.test(text)) tags.add("Brygga");
  if (/dusch/.test(text)) tags.add("Dusch");
  if (/parkering|parkeringsplats/.test(text)) tags.add("Parkering");
  toArray(beach.nearbyAmenities).forEach((item) => {
    if (item?.label && item.label !== "Tillgängligt") tags.add(item.label);
  });
  return [...tags].sort((a, b) => a.localeCompare(b, "sv-SE"));
}

function classificationText(beach) {
  return toArray(beach.profile?.lastFourClassifications)
    .map((item) => `${item.year}: ${item.qualityClassIdText || "okänt"}`);
}

function contactInfo(beach) {
  const contact = beach.profile?.bathingWater?.municipality?.contactInfo
    || beach.profile?.municipality?.contactInfo
    || beach.profile?.supervisoryAuthority?.contactInfo
    || null;
  return contact ? {
    name: contact.name || "",
    phone: contact.phone || "",
    email: contact.email || "",
    url: contact.url || beach.municipalityUrl || ""
  } : {
    name: "",
    phone: "",
    email: "",
    url: beach.municipalityUrl || ""
  };
}

function mapBeach(beach, imageRecord) {
  const latest = beach.latestResult || {};
  const description = compactText(uniqueTextParts([
    beach.profile?.summary,
    beach.profile?.bathingWater?.description,
    beach.description
  ]).join(" "), 1100);
  return {
    id: beach.id,
    name: beach.name,
    municipality: beach.municipality,
    municipalityUrl: beach.municipalityUrl || "",
    lat: parseNumber(beach.lat),
    lon: parseNumber(beach.lon),
    type: beach.type || "",
    description,
    quality: qualityText(beach),
    latestSampleDate: dateOnly(latest.takenAt),
    ecoli: latest.escherichiaColiCount ?? null,
    enterococci: latest.intestinalEnterococciCount ?? null,
    algae: latest.algalIdText || "Uppgift saknas",
    services: serviceTags(beach),
    classifications: classificationText(beach),
    bathingSeason: {
      startsAt: dateOnly(beach.profile?.bathingSeason?.startsAt),
      endsAt: dateOnly(beach.profile?.bathingSeason?.endsAt)
    },
    contact: contactInfo(beach),
    images: toArray(imageRecord?.images).slice(0, 4),
    imageCheckedAt: imageRecord?.imageCheckedAt || null,
    imageSearchVersion: imageRecord?.imageSearchVersion || null
  };
}

function commonsDistanceMeters(coords, beach) {
  const coord = toArray(coords).find((item) => item?.lat && item?.lon);
  if (!coord) return null;
  const radius = 6371000;
  const lat1 = beach.lat * Math.PI / 180;
  const lat2 = coord.lat * Math.PI / 180;
  const dLat = (coord.lat - beach.lat) * Math.PI / 180;
  const dLon = (coord.lon - beach.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function imageAgeDays(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? Math.max(0, (Date.now() - time) / 86400000) : Infinity;
}

function shouldRefreshImages(existing) {
  if (!existing || existing.imageSearchVersion !== IMAGE_SEARCH_VERSION) return true;
  const maxAge = toArray(existing.images).length ? FILLED_IMAGE_RECHECK_DAYS : EMPTY_IMAGE_RECHECK_DAYS;
  return imageAgeDays(existing.imageCheckedAt) >= maxAge;
}

function candidateRelevance(page, beach, source) {
  const info = page.imageinfo?.[0];
  if (!info || !String(info.mime || "").startsWith("image/")) return null;
  const title = String(page.title || "").replace(/^File:/, "");
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle || IRRELEVANT_WORDS.test(normalizedTitle)) return null;

  const evidence = nameEvidence(title, beach);
  const nameMatches = evidence.nameMatches;
  const isScene = sceneMatch(normalizedTitle);
  const distanceMeters = commonsDistanceMeters(page.coordinates, beach);
  const exactDistance = Number.isFinite(distanceMeters) && distanceMeters <= COMMONS_EXACT_RADIUS_METERS;
  const fallbackDistance = Number.isFinite(distanceMeters) && distanceMeters <= COMMONS_FALLBACK_RADIUS_METERS;

  if (source === "coordinates" && (!exactDistance || !isScene && !nameMatches)) return null;
  if (source === "name" && !reliableNameMatch(title, beach, distanceMeters)) return null;
  if (source === "name" && Number.isFinite(distanceMeters) && !fallbackDistance) return null;

  const score = nameMatches * 120
    + (isScene ? 45 : 0)
    + (source === "name" ? 25 : 0)
    + (Number.isFinite(distanceMeters) ? Math.max(0, 35 - distanceMeters / 30) : 0);
  return {
    score,
    image: {
      title,
      url: info.thumburl || info.url,
      originalUrl: info.descriptionurl || "",
      source: "Wikimedia Commons",
      license: stripTags(info.extmetadata?.LicenseShortName?.value || ""),
      author: stripTags(info.extmetadata?.Artist?.value || ""),
      distanceMeters,
      matchType: source
    }
  };
}

function existingImageIsRelevant(image, beach) {
  const normalizedTitle = normalizeText(image?.title);
  if (!normalizedTitle || IRRELEVANT_WORDS.test(normalizedTitle)) return false;
  const nameMatches = beachNameTokens(beach).some((token) => normalizedTitle.includes(token));
  const isScene = sceneMatch(normalizedTitle);
  const distanceMeters = parseNumber(image.distanceMeters);
  if (image.matchType === "name") return reliableNameMatch(image.title, beach, distanceMeters);
  return Number.isFinite(distanceMeters)
    && distanceMeters <= COMMONS_EXACT_RADIUS_METERS
    && (nameMatches || isScene);
}

async function throttleCommons() {
  const previous = commonsRequestQueue;
  let release;
  commonsRequestQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  const waitMs = Math.max(0, COMMONS_DELAY_MS - (Date.now() - lastCommonsRequestAt));
  if (waitMs) await sleep(waitMs);
  lastCommonsRequestAt = Date.now();
  release();
}

async function fetchCommonsPages(params) {
  if (commonsRateLimited) return null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await throttleCommons();
    const response = await fetch(`${COMMONS_API}?${params}`, {
      headers: { "User-Agent": "skane-badguiden-map/2.0 (GitHub Pages data builder)" },
      signal: AbortSignal.timeout(15000)
    });
    const retryable = response.status === 429 || response.status === 503;
    if (retryable) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 4000 * (attempt + 1);
      if (attempt === 3) {
        commonsRateLimited = true;
        throw new Error(`${response.status} ${response.statusText} efter fyra försök`);
      }
      console.warn(`Commons svarade ${response.status}; väntar ${Math.round(waitMs / 1000)} s före nytt försök.`);
      await sleep(waitMs);
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    if (data.error?.code === "maxlag") {
      if (attempt === 3) throw new Error(`Commons maxlag efter fyra försök: ${data.error.info || "okänt fel"}`);
      await sleep(4000 * (attempt + 1));
      continue;
    }
    return Object.values(data.query?.pages || {});
  }
  return [];
}

function commonImageParams() {
  return {
    action: "query",
    format: "json",
    origin: "*",
    prop: "imageinfo|coordinates",
    iiprop: "url|extmetadata|mime|size",
    iiurlwidth: "1200",
    iiurlheight: "760",
    coprimary: "all",
    maxlag: "5"
  };
}

async function fetchCommonsImages(beach) {
  if (commonsRateLimited) return null;
  if (!Number.isFinite(beach.lat) || !Number.isFinite(beach.lon)) {
    return { imageCheckedAt: new Date().toISOString(), imageSearchVersion: IMAGE_SEARCH_VERSION, images: [] };
  }

  try {
    const searchQuery = String(beach.name).replace(/[,/]/g, " ").replace(/\s+/g, " ").trim();
    const searchParams = new URLSearchParams({
      ...commonImageParams(),
      generator: "search",
      gsrnamespace: "6",
      gsrlimit: String(COMMONS_LIMIT),
      gsrsearch: searchQuery
    });
    const searchPages = await fetchCommonsPages(searchParams);
    if (searchPages === null) return null;
    const candidates = toArray(searchPages).map((page) => candidateRelevance(page, beach, "name")).filter(Boolean);

    if (candidates.length < 4 && !commonsRateLimited) {
      const geoParams = new URLSearchParams({
        ...commonImageParams(),
        generator: "geosearch",
        ggsnamespace: "6",
        ggscoord: `${beach.lat}|${beach.lon}`,
        ggsradius: String(COMMONS_EXACT_RADIUS_METERS),
        ggslimit: String(COMMONS_LIMIT)
      });
      const geoPages = await fetchCommonsPages(geoParams);
      if (geoPages === null && !candidates.length) return null;
      candidates.push(...toArray(geoPages).map((page) => candidateRelevance(page, beach, "coordinates")).filter(Boolean));
    }

    const seen = new Set();
    const images = candidates
      .sort((a, b) => b.score - a.score || (a.image.distanceMeters ?? Infinity) - (b.image.distanceMeters ?? Infinity))
      .filter(({ image }) => {
        const key = image.originalUrl || image.url || normalizeText(image.title);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ image }) => image)
      .filter(Boolean)
      .slice(0, 4);
    return { imageCheckedAt: new Date().toISOString(), imageSearchVersion: IMAGE_SEARCH_VERSION, images };
  } catch (error) {
    console.warn(`Commons image lookup failed for ${beach.name}: ${error.message}`);
    return null;
  }
}

async function main() {
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  const previous = JSON.parse(await readFile(previousPath, "utf8").catch(() => "null"));
  const previousImages = new Map(toArray(previous?.beaches).map((beach) => [beach.id, {
    imageCheckedAt: beach.imageCheckedAt || null,
    imageSearchVersion: beach.imageSearchVersion || null,
    images: toArray(beach.images)
  }]));
  const imageRecords = new Map(previousImages);

  const beaches = toArray(data.beaches)
    .filter((beach) => beach.id && Number.isFinite(parseNumber(beach.lat)) && Number.isFinite(parseNumber(beach.lon)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "sv-SE"));

  const makePayload = () => ({
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      sourceDataGeneratedAt: data.generatedAt || null,
      source: "HaV badplatsdata, lokal cache och relevanskontrollerade Wikimedia Commons-bilder där sådana hittades",
      imageSourceNote: `Bilder hämtas från Wikimedia Commons. Koordinatträffar måste ligga inom ${COMMONS_EXACT_RADIUS_METERS} meter och visa strand- eller badmiljö. Namnträffar måste matcha badplatsens namn och får ligga högst ${COMMONS_FALLBACK_RADIUS_METERS} meter bort när bildkoordinat finns. Saknas en säker träff visas ingen bild.`,
      count: beaches.length,
      beaches: beaches.map((beach) => mapBeach(beach, imageRecords.get(beach.id)))
    });
  const writePayload = async () => {
    const payload = makePayload();
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
    return payload;
  };

  const targets = beaches.filter((beach) => shouldRefreshImages(imageRecords.get(beach.id)));
  let processed = 0;
  for (let start = 0; start < targets.length; start += IMAGE_BATCH_SIZE) {
    const batch = targets.slice(start, start + IMAGE_BATCH_SIZE);
    await Promise.all(batch.map(async (beach) => {
      const existing = imageRecords.get(beach.id);
      let rejectedByNewRules = false;
      if (existing?.imageSearchVersion !== IMAGE_SEARCH_VERSION) {
        const oldImages = toArray(existing?.images);
        const filtered = oldImages
          .filter((image) => existingImageIsRelevant(image, beach))
          .map((image) => ({
            ...image,
            matchType: image.matchType || (Number.isFinite(parseNumber(image.distanceMeters)) ? "coordinates" : "name")
          }))
          .slice(0, 4);
        if (filtered.length || !oldImages.length) {
          imageRecords.set(beach.id, {
            imageCheckedAt: new Date().toISOString(),
            imageSearchVersion: IMAGE_SEARCH_VERSION,
            images: filtered
          });
          return;
        }
        rejectedByNewRules = oldImages.length > 0;
      }
      const refreshed = await fetchCommonsImages(beach);
      if (refreshed) {
        imageRecords.set(beach.id, refreshed);
      } else if (rejectedByNewRules || !existing) {
        imageRecords.set(beach.id, {
          imageCheckedAt: new Date().toISOString(),
          imageSearchVersion: IMAGE_SEARCH_VERSION,
          images: []
        });
      } else {
        imageRecords.set(beach.id, {
          ...existing,
          imageCheckedAt: new Date().toISOString()
        });
      }
    }));
    processed += batch.length;
    if (processed % CHECKPOINT_EVERY === 0) await writePayload();
  }

  const payload = await writePayload();
  const imageCount = payload.beaches.reduce((sum, beach) => sum + beach.images.length, 0);
  console.log(`Wrote ${payload.beaches.length} map beaches and ${imageCount} images to ${outputPath}; refreshed ${processed} image records`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
