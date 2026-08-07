import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [rankingHtml, mapHtml, data] = await Promise.all([
  readFile(resolve(root, "index.html"), "utf8"),
  readFile(resolve(root, "karta.html"), "utf8"),
  readFile(resolve(root, "data.json"), "utf8").then(JSON.parse)
]);

for (const [name, html] of [["ranking", rankingHtml], ["map", mapHtml]]) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]).filter(Boolean);
  assert.ok(scripts.length, `${name} ska innehålla JavaScript.`);
  scripts.forEach((script) => new Function(script));
}

assert.match(rankingHtml, /const QUALITY_MAX_AGE_DAYS = 365;/);
assert.match(mapHtml, /const QUALITY_MAX_AGE_DAYS = 365;/);
assert.doesNotMatch(rankingHtml, /sampleAge > (?:21|30)/);
assert.doesNotMatch(rankingHtml, /\(sampleAge - 14\)/);
assert.match(rankingHtml, /äldre eller ofullständiga prov rekommenderas inte/i);
assert.match(rankingHtml, /function hasQualityRemark/);
assert.match(mapHtml, /Saknas\/äldre än 12 månader/);
assert.match(mapHtml, /quality\.includes\("anm"\)/);

const now = Date.now();
const ageDays = (value) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 86400000)) : null;
};
const qualityIsCurrent = (takenAt, assessment) => {
  const age = ageDays(takenAt);
  const text = String(assessment || "").toLowerCase();
  return Number.isFinite(age)
    && age <= 365
    && Boolean(text)
    && !/uppgift saknas|ej bedömt|ej hämtad|otillgänglig/.test(text);
};
const hasAssessment = (beach) => {
  const text = String(beach.latestResult?.sampleAssessIdText || "").toLowerCase();
  return Boolean(text) && !/uppgift saknas|ej bedömt|ej hämtad|otillgänglig/.test(text);
};

const currentQuality = data.beaches.filter((beach) => {
  const age = ageDays(beach.latestResult?.takenAt);
  return Number.isFinite(age) && age <= 365 && hasAssessment(beach);
});
const acceptedBeyondOldLimit = currentQuality.filter((beach) => ageDays(beach.latestResult?.takenAt) > 30);
const staleQuality = data.beaches.filter((beach) => {
  const age = ageDays(beach.latestResult?.takenAt);
  return !Number.isFinite(age) || age > 365 || !hasAssessment(beach);
});

assert.equal(data.beaches.length, 175, "Alla 175 badplatser ska finnas kvar.");
assert.ok(currentQuality.length > 0, "Minst ett bad ska ha ett användbart prov inom 12 månader.");
assert.equal(qualityIsCurrent(new Date(now - 364 * 86400000).toISOString(), "Tjänligt"), true);
assert.equal(qualityIsCurrent(new Date(now - 365 * 86400000).toISOString(), "Tjänligt"), true);
assert.equal(qualityIsCurrent(new Date(now - 366 * 86400000).toISOString(), "Tjänligt"), false);
assert.equal(qualityIsCurrent(new Date(now - 60 * 86400000).toISOString(), "Uppgift saknas"), false);

console.log(`OK: ${currentQuality.length} av ${data.beaches.length} bad har kvalitetsprov inom 12 månader med bedömning.`);
console.log(`OK: ${acceptedBeyondOldLimit.length} prov äldre än 30 dagar godtas nu; ${staleQuality.length} gamla/ofullständiga prov stoppas.`);
