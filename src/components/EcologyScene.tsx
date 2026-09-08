import { useCallback, useEffect, useRef, useState } from 'react';
import type { EcologySnapshot, EcologyStageController } from '../hilo/EcologyStageController';
import { createLivingWorld, LIVING_CAST, type LivingPhoto, type LivingTool, type LivingWeather } from '../ecology/livingTypes';
import { appendPhoto, emptyJournal, loadLivingJournal, recordDiscoveries, removePhoto, saveLivingJournal,
  type JournalStorage, type LivingJournal } from '../ecology/livingJournal';
import { LivingIcon as Icon } from './LivingIcon';
import { LivingJournalPanel, type LivingPanel } from './LivingJournalPanel';
import '../ecology.css';

interface EcologySceneProps { assetBase: string; onBack(): void }
type Notice = { text: string; error: boolean } | null;
const initialSnapshot: EcologySnapshot = {
  count: 0, pending: 0, paused: false, toon: false, timeOfDay: 'dawn', agents: [], events: [], selectedId: null, followingId: null,
  tool: 'observe', world: createLivingWorld(), discoveries: [], elapsed: 0, livingReady: false, residentTarget: LIVING_CAST.length,
};
const tools: { id: LivingTool; label: string; icon: string }[] = [
  { id: 'observe', label: '观察', icon: 'eye' }, { id: 'fruit', label: '投果', icon: 'fruit' },
  { id: 'shake-tree', label: '摇树', icon: 'tree' }, { id: 'prepare-fire', label: '备柴', icon: 'fire' },
  { id: 'rustle-flowers', label: '拨花', icon: 'flower' },
];
function storageAvailable(): JournalStorage | null { try { return window.localStorage; } catch { return null; } }
const audioPreferenceKey = 'natura.living-audio.v1';
function initialAudioPreference(): boolean { try { return window.localStorage.getItem(audioPreferenceKey) !== 'muted'; } catch { return true; } }

export function EcologyScene({ assetBase, onBack }: EcologySceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<EcologyStageController | null>(null);
  const snapshotRef = useRef(initialSnapshot);
  const journalRef = useRef<LivingJournal>(emptyJournal());
  const storageRef = useRef<JournalStorage | null>(null);
  const canPersistRef = useRef(false);
  const journalLoaded = useRef(false);
  const mountedRef = useRef(false);
  const pauseAfterClose = useRef<boolean | null>(null);
  const captureBusy = useRef(false);
  const panelOpenRef = useRef(false);
  const panelTriggerRef = useRef<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [journal, setJournal] = useState<LivingJournal>(emptyJournal);
  const [notice, setNotice] = useState<Notice>(null);
  const [panel, setPanel] = useState<LivingPanel | null>(null);
  const [photo, setPhoto] = useState<LivingPhoto | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<LivingPhoto | null>(null);
  const [ready, setReady] = useState(false);
  const [stageError, setStageError] = useState('');
  const [backend, setBackend] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [boot, setBoot] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(initialAudioPreference);
  const soundEnabledRef = useRef(soundEnabled);
  panelOpenRef.current = panel !== null;
  const openPanel = useCallback((next: LivingPanel): void => {
    if (!panelOpenRef.current) panelTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
  }, []);

  useEffect(() => {
    if (journalLoaded.current) return;
    journalLoaded.current = true; storageRef.current = storageAvailable();
    const loaded = loadLivingJournal(storageRef.current);
    journalRef.current = loaded.journal; setJournal(loaded.journal); canPersistRef.current = loaded.canPersist;
    if (loaded.notice) setNotice({ text: loaded.notice, error: true });
  }, []);
  const store = useCallback((next: LivingJournal, requireSaved = false): boolean => {
    const result = canPersistRef.current ? saveLivingJournal(storageRef.current, next)
      : { ok: false, notice: '当前无法写入本地收藏，原记录未覆盖。请先下载照片或收藏备份。' };
    if (!result.ok) setNotice({ text: result.notice, error: true });
    if (result.ok || !requireSaved) { journalRef.current = next; setJournal(next); }
    return result.ok;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let controller: EcologyStageController | null = null;
    mountedRef.current = true; setReady(false); setStageError('');
    snapshotRef.current = initialSnapshot; setSnapshot(initialSnapshot);
    void import('../hilo/EcologyStageController').then(({ EcologyStageController: Controller }) => {
      if (cancelled) return null;
      return Controller.create({ container, assetBase,
        onBackend: (value) => { if (!cancelled) setBackend(value); },
        onChange: (value) => {
          if (cancelled) return;
          snapshotRef.current = value; setSnapshot(value);
          const previous = journalRef.current, next = recordDiscoveries(previous, value.discoveries);
          if (next !== previous) {
            const saved = store(next), first = next.discoveries[previous.discoveries.length];
            if (saved && first) setNotice({ text: `新发现 · ${first.title}${next.discoveries.length - previous.discoveries.length > 1 ? ` 等 ${next.discoveries.length - previous.discoveries.length} 条` : ''}`, error: false });
          }
        },
        onError: (message) => { if (!cancelled && message.trim()) setNotice({ text: message, error: true }); },
      });
    }).then(async (created) => {
      if (!created) return;
      if (cancelled) { created.destroy(); return; }
      controller = created; controllerRef.current = created; created.resize(); created.setSoundEnabled(soundEnabledRef.current); setReady(true);
      if (panelOpenRef.current) created.setPaused(true);
      await created.startLiving();
      if (!cancelled && snapshotRef.current.count === 0) throw new Error('居民暂时没有抵达，请重新打开箱庭再试一次。');
    }).catch((error: unknown) => { if (!cancelled) setStageError(error instanceof Error ? error.message : '这个小世界暂时没有打开，请再试一次。'); });
    const resize = (): void => controller?.resize();
    const observer = new ResizeObserver(resize); observer.observe(container); window.addEventListener('resize', resize);
    return () => {
      cancelled = true; mountedRef.current = false; observer.disconnect(); window.removeEventListener('resize', resize);
      if (controllerRef.current === controller) controllerRef.current = null;
      controller?.destroy();
    };
  }, [assetBase, boot, store]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const id = window.setTimeout(() => setNotice(null), 5200);
    return () => window.clearTimeout(id);
  }, [notice]);
  const modalOpen = panel !== null;
  useEffect(() => {
    if (!modalOpen) return;
    const wasPaused = snapshotRef.current.paused;
    controllerRef.current?.setPaused(true);
    return () => { controllerRef.current?.setPaused(pauseAfterClose.current ?? wasPaused); pauseAfterClose.current = null; };
  }, [modalOpen]);

  const savePhoto = useCallback((captured: LivingPhoto): void => {
    const appended = appendPhoto(journalRef.current, captured);
    if (appended.notice) { setPendingPhoto(captured); setNotice({ text: appended.notice, error: true }); }
    else if (store(appended.journal, true)) { setPendingPhoto(null); setNotice({ text: '这一刻已收进相册。', error: false }); }
    else setPendingPhoto(captured);
  }, [store]);
  const takePhoto = useCallback(async (): Promise<void> => {
    const controller = controllerRef.current;
    if (!controller || captureBusy.current || !snapshotRef.current.livingReady || !snapshotRef.current.count) return;
    if (pendingPhoto) { setPhoto(pendingPhoto); openPanel('album'); setNotice({ text: '还有一张未保存的照片，请先保存、下载或整理它。', error: true }); return; }
    captureBusy.current = true; setCapturing(true);
    try {
      const captured = await controller.capturePhoto();
      if (!mountedRef.current) return;
      setPhoto(captured); savePhoto(captured); openPanel('album');
    } catch (error: unknown) { if (mountedRef.current) setNotice({ text: error instanceof Error ? error.message : '这一张没有拍好，请再试一次。', error: true }); }
    finally { captureBusy.current = false; if (mountedRef.current) setCapturing(false); }
  }, [pendingPhoto, savePhoto, openPanel]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (panel || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLElement && event.target.matches('input,textarea,select,[contenteditable="true"]')) return;
      if (event.key === 'Escape') controllerRef.current?.setTool('observe');
      if (!snapshotRef.current.livingReady) return;
      if (event.key.toLowerCase() === 'f') controllerRef.current?.setTool('fruit');
      if (event.key.toLowerCase() === 'o') controllerRef.current?.setTool('observe');
      if (event.key.toLowerCase() === 'c') { event.preventDefault(); void takePhoto(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [panel, takePhoto]);
  const intervene = (tool: LivingTool): void => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (tool === 'observe' || tool === 'fruit') { controller.setTool(tool); return; }
    const result = controller.intervene(tool);
    if (result) setNotice({ text: tool === 'shake-tree' ? '树叶晃了晃，看看谁先注意到。' : tool === 'prepare-fire' ? '干柴准备好了，等一位喜欢温暖的伙伴。' : '花丛轻轻摇动，花香飘开了。', error: false });
  };
  const restart = async (): Promise<void> => {
    if (restarting || !controllerRef.current) return;
    pauseAfterClose.current = false;
    setPanel(null); setRestarting(true); setStageError('');
    try { await controllerRef.current.restartLiving(); if (snapshotRef.current.count === 0) throw new Error('居民暂时没有抵达，请重新打开箱庭再试一次。'); }
    catch (error: unknown) { if (mountedRef.current) setStageError(error instanceof Error ? error.message : '居民还没准备好，请再试一次。'); }
    finally { if (mountedRef.current) setRestarting(false); }
  };
  const selected = snapshot.agents.find((agent) => agent.uid === snapshot.followingId);
  const toggleSound = (): void => {
    const next = !soundEnabledRef.current;
    soundEnabledRef.current = next; setSoundEnabled(next);
    controllerRef.current?.setSoundEnabled(next);
    if (next) controllerRef.current?.resumeAudioFromGesture();
    try { window.localStorage.setItem(audioPreferenceKey, next ? 'enabled' : 'muted'); } catch { /* Audio is available without persistence. */ }
  };
  const disabled = !ready || !snapshot.livingReady || restarting;
  const firePrepared = snapshot.world.campfire.prepared || snapshot.world.campfire.lit;
  const weather = snapshot.world.weather;
  const weatherNote = weather.kind === 'snow'
    ? weather.snow >= .6 ? '白雪覆盖' : weather.snow >= .15 ? '薄薄积雪' : '正在飘雪'
    : weather.snow > .03 ? '积雪慢慢融化' : weather.kind === 'rain' ? '细雨落在岛上' : null;

  return <div className="ecology-root living-root" data-time={snapshot.timeOfDay} data-weather={weather.kind} data-renderer={backend}>
    <div className="living-game" inert={modalOpen}>
      <header className="living-header"><div className="living-brand"><Icon name="tree" /><div><h1>共生之境</h1><small>A LITTLE WORLD, ALIVE.</small></div></div>
        <nav className="living-header-actions" aria-label="箱庭与收藏"><div className="living-time" role="group" aria-label="切换时间">
          <button disabled={!ready} aria-pressed={snapshot.timeOfDay === 'dawn'} onClick={() => controllerRef.current?.setTimeOfDay('dawn')}><Icon name="sun" /><span>清晨</span></button><button disabled={!ready} aria-pressed={snapshot.timeOfDay === 'dusk'} onClick={() => controllerRef.current?.setTimeOfDay('dusk')}><Icon name="dusk" /><span>黄昏</span></button>
        </div><label className="living-weather"><span>天气</span><select aria-label="选择天气" value={weather.kind} disabled={!ready} onChange={(event) => controllerRef.current?.setWeather(event.currentTarget.value as LivingWeather)}><option value="sunny">晴天</option><option value="rain">下雨</option><option value="snow">下雪</option></select></label><button className="living-icon-button living-sound-toggle" aria-label={soundEnabled ? '关闭岛上声音' : '开启岛上声音'} aria-pressed={soundEnabled} title={soundEnabled ? '岛上声音已开启，点击静音' : '点击听听岛上的声音'} onClick={toggleSound}><Icon name={soundEnabled ? 'sound' : 'muted'} /></button><button className="living-nav-button" onClick={() => { setPhoto(null); openPanel('album'); }} aria-label={`打开相册，${journal.photos.length}张照片`}><Icon name="album" /><span>相册</span></button><button className="living-nav-button" onClick={() => openPanel('discoveries')} aria-label={`打开发现手记，已发现${journal.discoveries.length}条`}><Icon name="book" /><span>发现</span>{journal.discoveries.length > 0 && <i aria-hidden="true">{journal.discoveries.length}</i>}</button><button className="living-icon-button" onClick={() => openPanel('settings')} aria-label="箱庭设置与帮助"><Icon name="more" /></button></nav>
      </header>
      <main className="living-playfield" aria-label="共生之境生态箱庭">
        <div ref={containerRef} className="eco-canvas living-canvas" />
        {ready && <div className="living-world-note"><i />成熟果 {snapshot.world.tree.mature}<span>·</span>{weatherNote ?? (snapshot.world.campfire.lit ? '篝火暖着' : snapshot.world.campfire.prepared ? '柴堆已备好' : '篝火待添柴')}</div>}
        {selected && <div className="living-companion"><img src={`${assetBase}models/${selected.pokemonId}/icon.png`} alt="" /><div><b>{selected.name}</b><span>{selected.label}</span></div><button disabled={disabled || snapshot.paused} onClick={() => controllerRef.current?.petPokemon(selected.uid)} aria-label={`摸摸${selected.name}`}><Icon name="heart" />摸摸</button><button className="living-unfollow" onClick={() => controllerRef.current?.resetView()} aria-label="取消跟随，回到全景"><Icon name="close" /><span>取消跟随</span></button></div>}
        {snapshot.paused && <div className="living-paused"><button onClick={() => controllerRef.current?.setPaused(false)}><Icon name="play" />继续看它们生活</button></div>}
        {(!ready || !snapshot.livingReady || restarting) && !stageError && <div className="living-loading" role="status"><span className="living-loader" /><b>{ready ? '居民正陆续来到岛上' : '晨光正在落进小岛'}</b><span>{snapshot.count ? `${snapshot.count} / ${snapshot.residentTarget} 位居民已到` : '稍等一会儿，小世界就醒了。'}</span></div>}
        {stageError && <div className="living-loading living-load-error" role="alert"><b>小世界暂时没有打开</b><p>{stageError}</p><button onClick={() => { setPanel(null); setBoot((value) => value + 1); }}>重新打开</button><button onClick={onBack}>先去藏馆看看</button></div>}
        <div className="living-stage-edge"><span>{snapshot.tool === 'fruit' ? '点草地投果 · 拖动仍可转视角' : '看看它们，也看看彼此之间的小故事。'}</span><button disabled={!ready} onClick={() => controllerRef.current?.resetView()} aria-label="回到全景" title={selected ? '取消跟随，回到岛屿全景' : '回到岛屿全景'}><Icon name="reset" /><span>全景</span></button></div>
      </main>
      <footer className="living-bottom"><div className="living-tools" role="toolbar" aria-label="轻轻改变这个小世界" onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (index >= 0 && buttons.length) { event.preventDefault(); buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
      }}>{tools.map((tool) => <button key={tool.id} disabled={disabled || snapshot.paused || tool.id === 'prepare-fire' && firePrepared} aria-pressed={tool.id === 'observe' || tool.id === 'fruit' ? snapshot.tool === tool.id : undefined} aria-keyshortcuts={tool.id === 'fruit' ? 'F' : tool.id === 'observe' ? 'O' : undefined} title={tool.id === 'prepare-fire' && firePrepared ? snapshot.world.campfire.lit ? '火光正暖，等熄灭后再添柴' : '干柴已备好，等伙伴来点燃' : undefined} onClick={() => intervene(tool.id)}><Icon name={tool.icon} /><span>{tool.id === 'prepare-fire' && firePrepared ? snapshot.world.campfire.lit ? '火光正暖' : '柴已备好' : tool.label}</span></button>)}<span className="living-tool-divider" /><button className="living-shutter" disabled={disabled || !snapshot.count || capturing} onClick={() => void takePhoto()} aria-keyshortcuts="C"><Icon name="camera" /><span>{capturing ? '记录中' : '拍下来'}</span></button></div>
        <div className="living-resident-row"><span className="living-resident-caption">岛上伙伴 <b>{snapshot.count}</b></span><div className="living-residents" aria-label="岛上居民，点击跟随">{snapshot.agents.map((agent) => <button key={agent.uid} aria-pressed={selected?.uid === agent.uid} onClick={() => controllerRef.current?.focusPokemon(agent.uid)} aria-label={`跟随${agent.name}，${agent.label}`} title={`${agent.name} · ${agent.label}`}><img src={`${assetBase}models/${agent.pokemonId}/icon.png`} alt="" draggable="false" /></button>)}{!snapshot.agents.length && <span className="living-residents-empty">各有各的日常，一起生活在这里。</span>}</div></div>
      </footer>
    </div>
    {notice && <div className={`living-toast${notice.error ? ' is-error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="关闭提示"><Icon name="close" /></button></div>}
    {panel && <LivingJournalPanel panel={panel} journal={journal} photo={photo} pendingPhoto={pendingPhoto} assetBase={assetBase} ready={!disabled} returnFocus={panelTriggerRef.current} onClose={() => setPanel(null)} onPhoto={setPhoto} onSave={savePhoto}
      onRemove={(id) => { if (pendingPhoto?.id === id && !journalRef.current.photos.some((entry) => entry.id === id)) { setPendingPhoto(null); return true; } return store(removePhoto(journalRef.current, id), true); }}
      onPause={() => { pauseAfterClose.current = true; setPanel(null); }} onRestart={() => void restart()} onBack={onBack} />}
  </div>;
}
