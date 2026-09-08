import assert from 'node:assert/strict';
import { JOURNAL_KEY, PHOTO_LIMIT, emptyJournal, loadLivingJournal, saveLivingJournal, recordDiscoveries, appendPhoto, removePhoto, validPhoto } from '../src/ecology/livingJournal.ts';

class MemoryStorage {
  data = new Map(); fail = false;
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { if (this.fail) { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error; } this.data.set(key, value); }
}
const storage = new MemoryStorage();
const event = { id: 'behavior:eat', category: 'behavior', title: '吃饱了', description: '真实进食', speciesIds: ['025'], participantUids: ['resident-1'], at: 12 };
const photo = (id) => ({ id, title: '树荫午睡', capturedAt: '2026-09-08T00:00:00.000Z', timeOfDay: 'dawn', image: 'data:image/jpeg;base64,/9j/2Q==', speciesIds: ['025'], discoveryIds: ['behavior:eat'], labels: ['午睡'] });

assert.deepEqual(loadLivingJournal(storage).journal, emptyJournal());
let journal = recordDiscoveries(emptyJournal(), [event, event]);
assert.equal(journal.discoveries.length, 1);
assert.equal(recordDiscoveries(journal, [event]), journal, 'Repeated snapshot does not create a new record or storage write');
assert.equal(saveLivingJournal(storage, journal).ok, true);
journal = loadLivingJournal(storage).journal;
assert.equal(recordDiscoveries(journal, [{ ...event, at: 90 }]), journal, 'Stable discovery IDs survive refresh and later repeats');
assert.equal(recordDiscoveries(journal, [{ ...event, id: 'bad', at: NaN }]), journal);
assert.equal(recordDiscoveries(journal, [{ ...event, id: 'bad-category', category: { toString: 'broken' } }]), journal, 'Malformed category values cannot crash validation');

for (let i = 0; i < PHOTO_LIMIT; i++) journal = appendPhoto(journal, photo(`p${i}`)).journal;
assert.equal(journal.photos.length, PHOTO_LIMIT);
assert.equal(appendPhoto(journal, photo('new')).journal, journal, 'A full album never evicts old photos');
assert.ok(appendPhoto(journal, photo('new')).notice.includes('旧照片'));
const removed = removePhoto(journal, 'p0');
assert.equal(appendPhoto(removed, photo('new')).journal.photos.length, PHOTO_LIMIT);
assert.equal(appendPhoto(journal, { ...photo('unsafe'), image: 'data:image/svg+xml,<svg/>' }).journal, journal);
assert.equal(saveLivingJournal(storage, journal).ok, true);
const oldRaw = storage.getItem(JOURNAL_KEY);
storage.fail = true;
const quota = saveLivingJournal(storage, removed);
assert.equal(quota.ok, false); assert.ok(quota.notice.includes('空间已满'));
assert.equal(storage.getItem(JOURNAL_KEY), oldRaw, 'Failed writes preserve stored assets');
storage.fail = false;

storage.data.set(JOURNAL_KEY, '{broken json');
const recovered = loadLivingJournal(storage);
assert.equal(recovered.canPersist, true);
assert.equal(storage.getItem(JOURNAL_KEY), '{broken json', 'Loading never overwrites the primary payload');
assert.ok([...storage.data.entries()].some(([key, value]) => key.startsWith(`${JOURNAL_KEY}.recovery.`) && value === '{broken json'));
storage.fail = true;
assert.equal(loadLivingJournal(storage).canPersist, false, 'Do not overwrite unreadable data if backup fails');
storage.fail = false;
storage.data.set(JOURNAL_KEY, JSON.stringify({ schema: 1, discoveries: [event], photos: [photo('good'), { id: 'bad' }] }));
assert.deepEqual(loadLivingJournal(storage).journal.photos.map((p) => p.id), ['good']);
storage.data.set(JOURNAL_KEY, JSON.stringify({ schema: 1, discoveries: [], photos: Array.from({ length: PHOTO_LIMIT + 2 }, (_, i) => photo(`old-${i}`)) }));
assert.equal(loadLivingJournal(storage).journal.photos.length, PHOTO_LIMIT + 2, 'Older larger albums remain intact');
storage.data.set(JOURNAL_KEY, JSON.stringify({ schema: 900, photos: [photo('future')] }));
assert.ok(loadLivingJournal(storage).notice);
assert.equal(loadLivingJournal(null).canPersist, false);
assert.equal(loadLivingJournal({ getItem() { throw new Error('blocked'); }, setItem() {} }).canPersist, false);

const legacy = photo('legacy-sunny');
assert.equal(validPhoto(legacy), true, 'Photos made before weather metadata remain valid');
for (const weather of ['sunny', 'rain', 'snow']) {
  for (const snow of [0, .3, 1]) assert.equal(validPhoto({ ...photo(`${weather}-${snow}`), weather, snow }), true);
}
for (const weather of ['hail', '', null, 42, {}, []]) assert.equal(validPhoto({ ...photo('invalid-weather'), weather }), false);
for (const snow of [-.01, 1.01, NaN, Infinity, '0.5', null, {}]) assert.equal(validPhoto({ ...photo('invalid-snow'), weather: 'snow', snow }), false);
const weatherStorage = new MemoryStorage();
const oldAlbum = { schema: 1, discoveries: [], photos: [legacy] };
const oldAlbumRaw = JSON.stringify(oldAlbum);
weatherStorage.setItem(JOURNAL_KEY, oldAlbumRaw);
const loadedOld = loadLivingJournal(weatherStorage);
assert.equal(loadedOld.notice, '');
assert.equal(weatherStorage.getItem(JOURNAL_KEY), oldAlbumRaw, 'Loading an old album does not migrate or rewrite it');
assert.equal(Object.hasOwn(loadedOld.journal.photos[0], 'weather'), false, 'Sunny is a presentation fallback, not a persisted replacement');
const mixedAlbum = appendPhoto(loadedOld.journal, { ...photo('snowy-day'), weather: 'snow', snow: .65 }).journal;
assert.equal(saveLivingJournal(weatherStorage, mixedAlbum).ok, true);
const reloadedMixed = loadLivingJournal(weatherStorage).journal;
assert.equal(reloadedMixed.photos.length, 2);
assert.deepEqual(reloadedMixed.photos.find((item) => item.id === legacy.id), legacy, 'Saving new weather photos preserves old photo metadata and image');
assert.equal(reloadedMixed.photos[0].weather, 'snow');
assert.equal(reloadedMixed.photos[0].snow, .65);
weatherStorage.setItem(JOURNAL_KEY, JSON.stringify({ ...oldAlbum, photos: [legacy, { ...photo('damaged-weather'), weather: 'hail' }] }));
const weatherRecovery = loadLivingJournal(weatherStorage);
assert.deepEqual(weatherRecovery.journal.photos, [legacy]);
assert.ok(weatherRecovery.notice, 'Invalid weather is recovered visibly, with the original payload backed up');
assert.ok([...weatherStorage.data.entries()].some(([key, value]) => key.startsWith(`${JOURNAL_KEY}.recovery.`) && value.includes('damaged-weather')));
console.log('Living journal: stable discoveries, reload, photo limit, schema recovery, quota safety and backward-compatible weather metadata passed.');
