import type { DiscoveryCandidate, DiscoveryRecord, LivingPhoto } from './livingTypes.ts';

export const JOURNAL_KEY = 'natura.living-journal.v1';
export const PHOTO_LIMIT = 12;
export interface LivingJournal { schema: 1; discoveries: DiscoveryRecord[]; photos: LivingPhoto[] }
export interface JournalStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface JournalLoad { journal: LivingJournal; notice: string; canPersist: boolean }
export const emptyJournal = (): LivingJournal => ({ schema: 1, discoveries: [], photos: [] });

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const strings = (v: unknown, max = 100): v is string[] => Array.isArray(v) && v.length <= max && v.every((item) => text(item, 200));
const species = (v: unknown): v is string[] => strings(v, 151) && v.every((id) => /^\d{3}$/.test(id));
const date = (v: unknown): v is string => text(v, 80) && Number.isFinite(Date.parse(v));

export function validDiscovery(v: unknown): v is DiscoveryCandidate {
  return object(v) && text(v.id) && typeof v.category === 'string' && ['species', 'behavior', 'moment'].includes(v.category)
    && text(v.title) && typeof v.description === 'string' && v.description.length <= 4000
    && species(v.speciesIds) && strings(v.participantUids)
    && typeof v.at === 'number' && Number.isFinite(v.at) && v.at >= 0;
}
export function validPhoto(v: unknown): v is LivingPhoto {
  return object(v) && text(v.id) && date(v.capturedAt) && text(v.title)
    && (v.timeOfDay === 'dawn' || v.timeOfDay === 'dusk') && species(v.speciesIds)
    && strings(v.discoveryIds) && strings(v.labels)
    && (v.weather === undefined || typeof v.weather === 'string' && ['sunny', 'rain', 'snow'].includes(v.weather))
    && (v.snow === undefined || typeof v.snow === 'number' && Number.isFinite(v.snow) && v.snow >= 0 && v.snow <= 1)
    && typeof v.image === 'string' && v.image.length <= 6_000_000
    && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/\r\n]+={0,2}$/.test(v.image);
}

function unique<T extends { id: string }>(entries: T[]): T[] {
  const ids = new Set<string>();
  return entries.filter((entry) => { if (ids.has(entry.id)) return false; ids.add(entry.id); return true; });
}

/** Recover usable entries only after preserving the original payload. */
export function loadLivingJournal(storage: JournalStorage | null): JournalLoad {
  if (!storage) return { journal: emptyJournal(), notice: '浏览器暂时无法保存收藏；本次记录仍可查看和下载。', canPersist: false };
  let raw: string | null;
  try { raw = storage.getItem(JOURNAL_KEY); }
  catch { return { journal: emptyJournal(), notice: '无法读取本地收藏；原记录未改动，本次内容可下载备份。', canPersist: false }; }
  if (raw === null) return { journal: emptyJournal(), notice: '', canPersist: true };
  let journal = emptyJournal();
  let damaged = true;
  try {
    const value: unknown = JSON.parse(raw);
    if (object(value) && value.schema === 1 && Array.isArray(value.discoveries) && Array.isArray(value.photos)) {
      const discoveries = unique(value.discoveries.filter((entry): entry is DiscoveryRecord => validDiscovery(entry) && object(entry) && date(entry.discoveredAt)));
      // Never truncate an existing album, even if an older version allowed more photos.
      const photos = unique(value.photos.filter(validPhoto));
      journal = { schema: 1, discoveries, photos };
      damaged = discoveries.length !== value.discoveries.length || photos.length !== value.photos.length;
    }
  } catch { /* Keep malformed JSON untouched until a recovery copy succeeds. */ }
  if (!damaged) return { journal, notice: '', canPersist: true };
  try {
    const prefix = `${JOURNAL_KEY}.recovery.${Date.now()}`;
    let key = prefix, suffix = 0;
    while (storage.getItem(key) !== null) key = `${prefix}.${++suffix}`;
    storage.setItem(key, raw);
    return { journal, notice: '部分收藏记录无法读取，原始数据已留在本地备份中，可用内容已恢复。', canPersist: true };
  } catch {
    return { journal, notice: '收藏数据需要恢复，但备份空间不足；原数据未覆盖。本次记录请先下载备份。', canPersist: false };
  }
}

export function saveLivingJournal(storage: JournalStorage | null, journal: LivingJournal): { ok: boolean; notice: string } {
  if (!storage) return { ok: false, notice: '浏览器暂时无法保存收藏，请下载照片或收藏备份。' };
  try { storage.setItem(JOURNAL_KEY, JSON.stringify(journal)); return { ok: true, notice: '' }; }
  catch (error: unknown) {
    const name = object(error) ? error.name : error instanceof Error ? error.name : '';
    return { ok: false, notice: name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
      ? '本地收藏空间已满，旧照片已保留。请先下载并移除部分照片，再保存这一张。'
      : '这次收藏未能写入本地，旧记录已保留。请先下载照片或收藏备份。' };
  }
}

export function recordDiscoveries(journal: LivingJournal, candidates: readonly DiscoveryCandidate[], now = new Date().toISOString()): LivingJournal {
  const ids = new Set(journal.discoveries.map((entry) => entry.id));
  const added: DiscoveryRecord[] = [];
  for (const candidate of candidates) {
    if (!validDiscovery(candidate) || ids.has(candidate.id)) continue;
    ids.add(candidate.id);
    added.push({ ...candidate, speciesIds: [...candidate.speciesIds], participantUids: [...candidate.participantUids], discoveredAt: now });
  }
  return added.length ? { ...journal, discoveries: [...journal.discoveries, ...added] } : journal;
}

export function appendPhoto(journal: LivingJournal, photo: LivingPhoto): { journal: LivingJournal; notice: string } {
  if (!validPhoto(photo)) return { journal, notice: '这张照片没有完整生成，请重新拍摄。' };
  if (journal.photos.some((entry) => entry.id === photo.id)) return { journal, notice: '' };
  if (journal.photos.length >= PHOTO_LIMIT) return { journal, notice: `相册已收好 ${PHOTO_LIMIT} 张照片。旧照片都在，请先下载并移除一张，再保存新照片。` };
  return { journal: { ...journal, photos: [photo, ...journal.photos] }, notice: '' };
}

export function removePhoto(journal: LivingJournal, id: string): LivingJournal {
  return { ...journal, photos: journal.photos.filter((photo) => photo.id !== id) };
}
