import { useEffect, useRef, useState } from 'react';
import { pokemon } from '../content/pokemon';
import { LIVING_CAST, type DiscoveryCategory, type LivingPhoto, type LivingWeather } from '../ecology/livingTypes';
import { PHOTO_LIMIT, type LivingJournal } from '../ecology/livingJournal';
import { LivingIcon as Icon } from './LivingIcon';

export type LivingPanel = 'album' | 'discoveries' | 'settings';
const names = new Map(pokemon.map((entry) => [entry.id, entry.name]));
const date = (value: string): string => new Date(value).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const categories: Record<DiscoveryCategory, string> = { species: '居民', behavior: '生活', moment: '瞬间' };
const weatherLabels: Record<LivingWeather, string> = { sunny: '晴天', rain: '雨天', snow: '雪天' };
const photoWeather = (photo: LivingPhoto): string => {
  const label = weatherLabels[photo.weather ?? 'sunny'];
  return (photo.snow ?? 0) >= .6 ? `${label} · 白雪覆盖` : (photo.snow ?? 0) >= .15 ? `${label} · 薄薄积雪` : label;
};
interface Props {
  panel: LivingPanel; journal: LivingJournal; photo: LivingPhoto | null; pendingPhoto: LivingPhoto | null; assetBase: string; ready: boolean;
  returnFocus: HTMLElement | null;
  onClose(): void; onPhoto(photo: LivingPhoto | null): void; onSave(photo: LivingPhoto): void;
  onRemove(id: string): boolean; onPause(): void; onRestart(): void; onBack(): void;
}
export function LivingJournalPanel({ panel, journal, photo, pendingPhoto, assetBase, ready, returnFocus, onClose, onPhoto, onSave, onRemove, onPause, onRestart, onBack }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const [category, setCategory] = useState<DiscoveryCategory>('species');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const previous = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    modalRef.current?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const buttons = [...(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length);
      const first = buttons[0], last = buttons.at(-1);
      if (!first || !last) { event.preventDefault(); modalRef.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && (document.activeElement === last || document.activeElement === modalRef.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  useEffect(() => setConfirmDelete(false), [photo?.id]);
  const saved = photo ? journal.photos.some((item) => item.id === photo.id) : false;
  const found = journal.discoveries.filter((entry) => entry.category === category);
  const exportBackup = (): void => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(journal, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = '共生之境-收藏备份.json'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="living-modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={modalRef} className={`living-modal${panel === 'settings' ? ' living-settings' : ''}`} role="dialog" aria-modal="true" aria-labelledby="living-dialog-title" tabIndex={-1}>
      <header className="living-modal-header"><div><small>KEEP A LITTLE OF TODAY.</small><h2 id="living-dialog-title">{panel === 'album' ? '留下的时光' : panel === 'discoveries' ? '发现手记' : '慢慢生活'}</h2></div><button className="living-icon-button" onClick={onClose} aria-label="关闭，回到箱庭"><Icon name="close" /></button></header>
      {panel === 'album' && (photo ? <div className="living-photo-detail">
        <button className="living-text-button" onClick={() => onPhoto(null)}>← 看全部照片</button>
        <img className="living-photo-large" src={photo.image} alt={photo.title} />
        <div className="living-photo-caption"><div><small>{photo.timeOfDay === 'dawn' ? '清晨' : '黄昏'} · {photoWeather(photo)} · {date(photo.capturedAt)}</small><h3>{photo.title}</h3><p>{photo.speciesIds.map((id) => names.get(id) ?? id).join(' · ') || '这一刻的岛屿风景'}</p></div><span className={`living-saved-label${saved ? '' : ' is-unsaved'}`}>{saved ? '已收进本地相册' : '尚未保存 · 可先下载'}</span></div>
        {photo.labels.length > 0 && <div className="living-photo-tags">{photo.labels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>}
        {photo.discoveryIds.length > 0 && <p className="living-photo-discoveries">关联发现：{photo.discoveryIds.map((id) => journal.discoveries.find((entry) => entry.id === id)?.title).filter(Boolean).join(' · ') || photo.labels.join(' · ') || '生活瞬间'}</p>}
        <div className="living-photo-actions"><a className="living-primary-button" href={photo.image} download={`共生之境-${photo.id}.${photo.image.startsWith('data:image/png') ? 'png' : photo.image.startsWith('data:image/webp') ? 'webp' : 'jpg'}`}><Icon name="download" />下载照片</a>
          {!saved && <button onClick={() => onSave(photo)}>保存到相册</button>}
          {!confirmDelete && <button className="living-text-button" onClick={() => setConfirmDelete(true)}>{saved ? '移除这张照片' : '放弃未保存照片'}</button>}
          {confirmDelete && <span className="living-delete-confirm">{saved ? '从本地相册移除？' : '放弃这张尚未保存的照片？'}<button onClick={() => { if (onRemove(photo.id)) { onPhoto(null); setConfirmDelete(false); } }}>确定移除</button><button onClick={() => setConfirmDelete(false)}>取消</button></span>}
        </div>
      </div> : <><p className="living-modal-intro">{journal.photos.length} / {PHOTO_LIMIT} 张照片，收在这台设备上。<span>满了以后，你可以下载并整理，旧照片会一直保留。</span></p>
        {pendingPhoto && <button className="living-pending-photo" onClick={() => onPhoto(pendingPhoto)}><Icon name="camera" />还有一张未保存的照片 <span>继续查看 →</span></button>}
        {journal.photos.length ? <div className="living-photo-grid">{journal.photos.map((entry) => <button key={entry.id} onClick={() => onPhoto(entry)}><img src={entry.image} alt={entry.title} loading="lazy" /><div><b>{entry.title}</b><small>{entry.timeOfDay === 'dawn' ? '清晨' : '黄昏'} · {photoWeather(entry)} · {date(entry.capturedAt)}</small></div></button>)}</div> : <div className="living-empty"><Icon name="camera" /><h3>还没有按下快门</h3><p>等它们接出一段小戏，或只是觉得此刻很好看。</p><button onClick={onClose}>回去看看</button></div>}
      </>)}
      {panel === 'discoveries' && <><p className="living-modal-intro">已经了解这个小世界的 {journal.discoveries.length} 件事。<span>只记录你真正看见的居民与已经发生的生活。</span></p>
        <div className="living-discovery-tabs" role="group" aria-label="发现分类">{(['species', 'behavior', 'moment'] as const).map((key) => <button key={key} aria-pressed={category === key} onClick={() => setCategory(key)}>{categories[key]} <b>{journal.discoveries.filter((entry) => entry.category === key).length}{key === 'species' ? ` / ${LIVING_CAST.length}` : ''}</b></button>)}</div>
        {found.length ? <div className="living-discovery-list">{found.map((entry) => <article key={entry.id}><div className="living-discovery-icons">{entry.speciesIds.slice(0, 3).map((id) => <img key={id} src={`${assetBase}models/${id}/icon.png`} alt={names.get(id) ?? id} />)}</div><div><h3>{entry.title}</h3><p>{entry.description}</p><small>初见 · {date(entry.discoveredAt)}</small></div></article>)}</div> : <div className="living-empty"><Icon name={category === 'species' ? 'eye' : category === 'behavior' ? 'tree' : 'book'} /><h3>下一页，留给下一次发现</h3><p>{category === 'species' ? '把视线移向岛上的伙伴，认出它们。' : category === 'behavior' ? '留意吃果、睡觉、花香和水花。' : '伙伴们互相回应时，故事就开始了。'}</p></div>}
      </>}
      {panel === 'settings' && <div className="living-settings-body"><p>不必一直做些什么。树果会成熟，伙伴会醒来，也会自己找地方休息。</p><div className="living-help"><span><b>观察</b>拖动旋转 · 滚轮或双指缩放</span><span><b>投果</b>选投果后点草地；按 F，再聚焦画面按回车</span><span><b>天气</b>雨雪会改变伙伴的去处；雪慢慢积起，也会融化。暂停时可换天气，积雪会等你继续。</span><span><b>留下此刻</b>点拍照或按 C；Esc 收起面板</span></div><div className="living-settings-actions">
        <button disabled={!ready} onClick={onPause}><Icon name="pause" />暂停一会儿</button>
        <button disabled={!ready} onClick={onRestart}><Icon name="reset" />重新开始今天<small>照片与发现都会保留</small></button>
        <button onClick={exportBackup}><Icon name="download" />下载收藏备份</button><button onClick={onBack}>去宝可梦藏馆 ↗</button>
      </div><small className="living-local-note">收藏保存在当前浏览器。重要照片可以下载留存。</small></div>}
    </div>
  </div>;
}
