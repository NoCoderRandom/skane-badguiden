import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(await readFile(resolve(root, "map-data.json"), "utf8"));
const errors = [];
const ids = new Set();
const blockedTitles = /kettlebell|helicopter|helikopter|utstallning|exhibition|camera lens|canon ef|wikivoyage banner|scout|bassang|rasthaus|skepparpsgarden|areskutan|halleberg|haggviks|vissefjarda|sillhovda|bottnaryd|jonkopings kommun|google art project|ulricehamn|orebro|visby|varberg/i;

function normalize(value) {
  return String(value || "")
    .toLocaleLowerCase("sv-SE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

if (data.count !== 175 || data.beaches?.length !== 175) {
  errors.push(`forvantade 175 badplatser men fick ${data.beaches?.length ?? 0}`);
}

for (const beach of data.beaches || []) {
  if (!beach.id || ids.has(beach.id)) errors.push(`saknat eller dubblerat id: ${beach.name || "okand"}`);
  ids.add(beach.id);
  if (beach.imageSearchVersion !== 7) errors.push(`${beach.name}: gammal bildsokningsversion`);
  if (!Array.isArray(beach.images) || beach.images.length > 4) errors.push(`${beach.name}: ogiltigt bildantal`);

  const localUrls = new Set();
  for (const image of beach.images || []) {
    const key = image.originalUrl || image.url;
    if (!image.title || !image.url || !image.originalUrl || !image.license || image.source !== "Wikimedia Commons") {
      errors.push(`${beach.name}: ofullstandig bildmetadata for ${image.title || "namnlos bild"}`);
    }
    if (localUrls.has(key)) errors.push(`${beach.name}: dubblerad bild ${image.title}`);
    localUrls.add(key);
    if (!/^https:\/\//.test(image.url) || !/^https:\/\/commons\.wikimedia\.org\//.test(image.originalUrl)) {
      errors.push(`${beach.name}: ogiltig bild- eller kallank`);
    }
    if (blockedTitles.test(normalize(image.title))) errors.push(`${beach.name}: blockerat motiv ${image.title}`);
    if (!new Set(["name", "coordinates"]).has(image.matchType)) errors.push(`${beach.name}: okand matchtyp`);
    if (image.matchType === "coordinates" && (!Number.isFinite(image.distanceMeters) || image.distanceMeters > 350)) {
      errors.push(`${beach.name}: koordinatbild ligger for langt bort`);
    }
    if (image.matchType === "name" && Number.isFinite(image.distanceMeters) && image.distanceMeters > 1800) {
      errors.push(`${beach.name}: namnbild ligger for langt bort`);
    }
  }
}

const beachesWithImages = (data.beaches || []).filter((beach) => beach.images?.length).length;
const imageCount = (data.beaches || []).reduce((sum, beach) => sum + (beach.images?.length || 0), 0);
if (beachesWithImages < 85) errors.push(`bildtackningen sjank till ${beachesWithImages} badplatser`);
if (imageCount < 170) errors.push(`bildantalet sjank till ${imageCount}`);

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`OK: ${imageCount} relevanskontrollerade bilder for ${beachesWithImages} av 175 badplatser.`);
