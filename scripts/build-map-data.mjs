import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = resolve(root, "data.json");
const previousPath = resolve(root, "map-data.json");
const outputPath = resolve(root, "map-data.json");
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const COMMONS_RADIUS_METERS = 260;
const COMMONS_LIMIT = 8;
const COMMONS_DELAY_MS = 350;
let commonsRateLimited = false;

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseNumber(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function compactText(value, max = 900) {
  return stripTags(value).slice(0, max);
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
  if (/tillgänglig|ramp|badru?llstol/.test(text)) tags.add("Tillgängligt");
  toArray(beach.nearbyAmenities).forEach((item) => {
    if (item?.label) tags.add(item.label);
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
    imageCheckedAt: imageRecord?.imageCheckedAt || null
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

async function fetchCommonsImages(beach) {
  if (commonsRateLimited) {
    return { imageCheckedAt: null, images: [] };
  }
  if (!Number.isFinite(beach.lat) || !Number.isFinite(beach.lon)) {
    return { imageCheckedAt: new Date().toISOString(), images: [] };
  }
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "geosearch",
    ggsnamespace: "6",
    ggscoord: `${beach.lat}|${beach.lon}`,
    ggsradius: String(COMMONS_RADIUS_METERS),
    ggslimit: String(COMMONS_LIMIT),
    prop: "imageinfo|coordinates",
    iiprop: "url|extmetadata|mime|size",
    iiurlwidth: "1200",
    iiurlheight: "760",
    coprimary: "all"
  });
  try {
    const response = await fetch(`${COMMONS_API}?${params}`, {
      headers: { "User-Agent": "skane-badguiden-map/1.0 (GitHub Pages data builder)" }
    });
    if (response.status === 429) commonsRateLimited = true;
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    const pages = Object.values(data.query?.pages || {});
    const images = pages
      .map((page) => {
        const info = page.imageinfo?.[0];
        if (!info || !String(info.mime || "").startsWith("image/")) return null;
        const distanceMeters = commonsDistanceMeters(page.coordinates, beach);
        if (!Number.isFinite(distanceMeters) || distanceMeters > COMMONS_RADIUS_METERS) return null;
        return {
          title: String(page.title || "").replace(/^File:/, ""),
          url: info.thumburl || info.url,
          originalUrl: info.descriptionurl || "",
          source: "Wikimedia Commons",
          license: stripTags(info.extmetadata?.LicenseShortName?.value || ""),
          author: stripTags(info.extmetadata?.Artist?.value || ""),
          distanceMeters
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 4);
    return { imageCheckedAt: new Date().toISOString(), images };
  } catch (error) {
    console.warn(`Commons image lookup failed for ${beach.name}: ${error.message}`);
    return { imageCheckedAt: null, images: [] };
  }
}

async function main() {
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  const previous = JSON.parse(await readFile(previousPath, "utf8").catch(() => "null"));
  const previousImages = new Map(toArray(previous?.beaches).map((beach) => [beach.id, {
    imageCheckedAt: beach.imageCheckedAt || null,
    images: toArray(beach.images)
  }]));
  const imageRecords = new Map(previousImages);

  const beaches = toArray(data.beaches)
    .filter((beach) => beach.id && Number.isFinite(parseNumber(beach.lat)) && Number.isFinite(parseNumber(beach.lon)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "sv-SE"));

  for (const beach of beaches) {
    const existing = imageRecords.get(beach.id);
    if (existing?.imageCheckedAt) continue;
    imageRecords.set(beach.id, await fetchCommonsImages(beach));
    if (commonsRateLimited) break;
    await sleep(COMMONS_DELAY_MS);
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceDataGeneratedAt: data.generatedAt || null,
    source: "HaV badplatsdata, lokal cache och verifierade koordinatnära Wikimedia Commons-bilder där sådana hittades",
    imageSourceNote: `Bilder hämtas endast från Wikimedia Commons när filens koordinat ligger inom ${COMMONS_RADIUS_METERS} meter från badplatsens koordinat. Saknas verifierad bild visas ingen bild.`,
    count: beaches.length,
    beaches: beaches.map((beach) => mapBeach(beach, imageRecords.get(beach.id)))
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
  const imageCount = payload.beaches.reduce((sum, beach) => sum + beach.images.length, 0);
  console.log(`Wrote ${payload.beaches.length} map beaches and ${imageCount} images to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
