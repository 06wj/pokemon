import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { pokemon, type PokemonEntry } from '../content/pokemon';
import { typeThemes } from '../content/typeThemes';
import type { PokemonType } from '../content/pokemonTypes';
import { ECOLOGY_CAPACITY } from '../ecology/config';
import type { EcologySnapshot, EcologyStageController } from '../hilo/EcologyStageController';
import '../ecology.css';

interface EcologySceneProps {
  assetBase: string;
  onBack(): void;
}

const SAMPLE_IDS = ['001', '002', '007', '008', '025', '133'];
const initialSnapshot: EcologySnapshot = {
  count: 0, pending: 0, paused: false, toon: false, timeOfDay: 'dawn', agents: [], events: [], selectedId: null, followingId: null,
};
const filters: readonly { id: 'all' | PokemonType; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'water', label: '水系' },
  { id: 'grass', label: '草系' }, { id: 'fire', label: '火系' },
];

function SunIcon({ dusk = false }: { dusk?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 17h18M5 21h14M7 13a5 5 0 0 1 10 0M12 2v3M3.5 6.5l2 2m15-2-2 2M1 12h3m16 0h3" />
    {dusk ? <path d="m10 9 2 2 2-2M12 7v4" /> : <path d="m10 10 2-2 2 2M12 8v4" />}
  </svg>;
}

function LeafIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4C10 2 4 7 5 13s9 8 12 2c2-4 2-7 2-11ZM4 21 15 9m-5 5 5 1m-5-1-1-4" /></svg>;
}

export function EcologyScene({ assetBase, onBack }: EcologySceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<EcologyStageController | null>(null);
  const snapshotRef = useRef(initialSnapshot);
  const mountedRef = useRef(false);
  const sampleGeneration = useRef(0);
  const [snapshot, setSnapshot] = useState<EcologySnapshot>(initialSnapshot);
  const [ready, setReady] = useState(false);
  const [backend, setBackend] = useState('');
  const [stageError, setStageError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | PokemonType>('all');
  const [addingSample, setAddingSample] = useState(false);
  const [showFieldNotes, setShowFieldNotes] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let controller: EcologyStageController | null = null;
    mountedRef.current = true;
    setReady(false);
    setStageError('');
    void import('../hilo/EcologyStageController').then(({ EcologyStageController: Controller }) => {
      if (cancelled) return null;
      return Controller.create({
        container, assetBase,
        onBackend: (value: string) => { if (!cancelled) setBackend(value); },
        onChange: (value: EcologySnapshot) => {
          if (cancelled) return;
          snapshotRef.current = value;
          setSnapshot(value);
        },
        onError: (message: string) => { if (!cancelled) setNotice(message); },
      });
    }).then((created) => {
      if (!created) return;
      if (cancelled) { created.destroy(); return; }
      controller = created;
      controllerRef.current = created;
      created.resize();
      setReady(true);
    }).catch((error: unknown) => {
      if (cancelled) return;
      console.error(error);
      setStageError(error instanceof Error ? error.message : '生态场景暂时无法打开');
    });
    const resize = (): void => controller?.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener('resize', resize);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      sampleGeneration.current += 1;
      observer.disconnect();
      window.removeEventListener('resize', resize);
      if (controllerRef.current === controller) controllerRef.current = null;
      controller?.destroy();
    };
  }, [assetBase]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.scrollIntoView({ block: 'nearest' });
      }
      if (event.key === 'Escape') setShowFieldNotes(false);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  const normalizedQuery = query.trim().toLowerCase().replace(/^(?:no\.?\s*|#)/, '');
  const filteredPokemon = useMemo(() => pokemon.filter((entry) => {
    const matchType = typeFilter === 'all' || entry.types.includes(typeFilter);
    const searchNumber = /^\d+$/.test(normalizedQuery) ? normalizedQuery.padStart(3, '0') : normalizedQuery;
    return matchType && (!normalizedQuery || entry.name.toLowerCase().includes(normalizedQuery) || entry.id.includes(searchNumber));
  }), [normalizedQuery, typeFilter]);
  const speciesCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of snapshot.agents) counts.set(agent.pokemonId, (counts.get(agent.pokemonId) ?? 0) + 1);
    return counts;
  }, [snapshot.agents]);
  const selected = snapshot.agents.find((agent) => agent.uid === snapshot.selectedId);
  const selectedEntry = selected ? pokemon.find((entry) => entry.id === selected.pokemonId) : undefined;
  const full = snapshot.count + snapshot.pending >= ECOLOGY_CAPACITY;
  const disabled = !ready || full;

  const addOne = useCallback(async (entry: PokemonEntry): Promise<void> => {
    const controller = controllerRef.current;
    if (!controller || snapshotRef.current.count + snapshotRef.current.pending >= ECOLOGY_CAPACITY) return;
    setNotice('');
    try { await controller.addPokemon(entry); }
    catch (error: unknown) {
      if (mountedRef.current) setNotice(error instanceof Error ? error.message : `${entry.name}暂时无法来到这里，请再试一次。`);
    }
  }, []);

  const addSample = async (): Promise<void> => {
    if (addingSample || disabled) return;
    const generation = ++sampleGeneration.current;
    setAddingSample(true);
    for (const id of SAMPLE_IDS) {
      if (!mountedRef.current || generation !== sampleGeneration.current) break;
      const entry = pokemon.find((item) => item.id === id);
      if (entry) await addOne(entry);
    }
    if (mountedRef.current && generation === sampleGeneration.current) setAddingSample(false);
  };

  const reset = (): void => {
    sampleGeneration.current += 1;
    setAddingSample(false);
    setNotice('');
    controllerRef.current?.reset();
  };

  return <div className="ecology-root" data-time={snapshot.timeOfDay} data-renderer={backend}>
    <header className="eco-topbar">
      <a className="brand" href="#001" onClick={(event) => { event.preventDefault(); onBack(); }} aria-label="返回宝可梦藏馆">
        <span className="brand-mark" aria-hidden="true"><i /></span>
        <span><b>NATURA<span>®</span></b><small>宝可梦 · 生态藏馆</small></span>
      </a>
      <nav className="eco-mode-nav" aria-label="选择场景">
        <button onClick={onBack}>藏馆</button>
        <span className="eco-mode-current" aria-current="page"><i />共生之境</span>
      </nav>
      <span className="eco-volume">KANTO <i>/</i> LIVING SANCTUARY</span>
    </header>

    <div className="eco-layout">
      <aside className="eco-catalogue" aria-label="选择宝可梦放入场景">
        <div className="eco-catalogue-heading"><div><small>INVITE A COMPANION</small><h2>邀一位伙伴</h2></div><LeafIcon /></div>
        <p className="eco-catalogue-intro">轻点列表，把它送进这片天地。</p>
        <label className="eco-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称或图鉴编号" aria-label="搜索宝可梦名称或编号" autoComplete="off" />
          <kbd>⌘ K</kbd>
        </label>
        <div className="eco-filters" role="group" aria-label="按属性筛选宝可梦">
          {filters.map((filter) => <button key={filter.id} onClick={() => setTypeFilter(filter.id)} aria-pressed={filter.id === typeFilter}>{filter.label}</button>)}
        </div>
        <div className="eco-dex-grid" aria-label="点击投放宝可梦">
          {filteredPokemon.map((entry) => {
            const count = speciesCount.get(entry.id) ?? 0;
            const theme = typeThemes[entry.types[0] ?? 'normal'];
            return <button className={`eco-dex-card${count ? ' is-present' : ''}`} type="button" key={entry.id}
              style={{ '--species-color': theme.accent } as CSSProperties} disabled={disabled}
              onClick={() => void addOne(entry)} title={full ? '场景已满，清空后可以继续邀请' : `放入一只${entry.name}`}
              aria-label={`放入一只${entry.name}${count ? `，场景中已有${count}只` : ''}`}>
              <small className="eco-dex-number">{entry.id}</small>
              {count > 0 && <span className="eco-dex-count" aria-hidden="true">×{count}</span>}
              <img src={`${assetBase}models/${entry.id}/icon.png`} alt="" loading="lazy" draggable="false" />
              <span className="eco-dex-name">{entry.name}</span>
              <span className="eco-dex-type"><i />{theme.label}</span>
              <span className="eco-dex-add" aria-hidden="true">+</span>
            </button>;
          })}
          {filteredPokemon.length === 0 && <div className="eco-search-empty"><LeafIcon /><b>还没找到这位伙伴</b><p>试试其他名称或编号。</p><button onClick={() => { setQuery(''); setTypeFilter('all'); }}>查看所有伙伴</button></div>}
        </div>
        <div className="eco-catalogue-footer"><span>{filteredPokemon.length} 位伙伴可邀请</span><span>可重复投放</span></div>
      </aside>

      <main className="eco-main" aria-label="宝可梦生态模拟场景">
        <section className="eco-stage" aria-label={`${snapshot.timeOfDay === 'dawn' ? '清晨' : '黄昏'}的共生之境，拖动旋转、滚轮缩放，点击宝可梦互动`}>
          <div className="eco-canvas" ref={containerRef} />
          <div className="eco-time-switch" role="group" aria-label="切换场景时间">
            <button aria-pressed={snapshot.timeOfDay === 'dawn'} disabled={!ready} onClick={() => controllerRef.current?.setTimeOfDay('dawn')}><SunIcon /><span>清晨<small>DAWN</small></span></button>
            <button aria-pressed={snapshot.timeOfDay === 'dusk'} disabled={!ready} onClick={() => controllerRef.current?.setTimeOfDay('dusk')}><SunIcon dusk /><span>黄昏<small>DUSK</small></span></button>
          </div>
          <div className="eco-stage-topline" aria-hidden="true"><span><i />溪谷 · 林间 · 花野</span><span>THE LIVING LANDSCAPE</span></div>
          <div className="eco-stage-corner eco-stage-corner-a" aria-hidden="true" />
          <div className="eco-stage-corner eco-stage-corner-b" aria-hidden="true" />
          {ready && !stageError && snapshot.count === 0 && snapshot.pending === 0 && <div className="eco-invitation">
            <small>A LITTLE WORLD, WAITING.</small><b>第一位访客，会是谁？</b><p>从列表邀请伙伴，观察它们自己的故事。</p>
            <button onClick={() => void addSample()} disabled={addingSample}>放入示例伙伴<span aria-hidden="true">↗</span></button>
          </div>}
          {!ready && !stageError && <div className="eco-loading" role="status"><span /><b>溪流与森林，正在苏醒…</b></div>}
          {stageError && <div className="eco-stage-error" role="alert"><LeafIcon /><b>这片天地暂时无法打开</b><p>{stageError}</p><button onClick={() => location.reload()}>重新加载</button></div>}
          {snapshot.pending > 0 && <div className="eco-arriving" role="status"><i />{snapshot.pending} 位伙伴正在抵达</div>}
          {snapshot.paused && <div className="eco-paused"><span /><b>此刻静止</b><small>继续后，伙伴们会接着探索</small></div>}
          {notice && <div className="eco-notice" role="alert"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}
          <div className="eco-scene-footer"><span>拖动环绕 <i>·</i> 滚轮缩放 <i>·</i> 轻点伙伴，回应它的好奇</span><span className="eco-scale-mark" title="所有伙伴保留原有大小关系，统一缩小至 90%">原比例 × 0.9</span></div>
        </section>

        <div className="eco-controls">
          <div className="eco-population" role="status" aria-live="polite"><i className={snapshot.paused ? 'is-paused' : ''} /><b>{snapshot.count.toString().padStart(2, '0')}</b><span>/ {ECOLOGY_CAPACITY}<small>{full ? '这片天地已满' : '位伙伴，自在生活'}</small></span></div>
          <div className="eco-control-actions">
            <button className="eco-control-button eco-pause-button" disabled={!ready} onClick={() => controllerRef.current?.setPaused(!snapshot.paused)} aria-pressed={snapshot.paused} aria-label={snapshot.paused ? '继续生态模拟' : '暂停生态模拟'} title={snapshot.paused ? '继续生态模拟' : '暂停生态模拟'}>{snapshot.paused ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6Z" /></svg> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10M13 5v10" /></svg>}<span>{snapshot.paused ? '继续' : '暂停'}</span></button>
            <button className="eco-control-button eco-camera-button" disabled={!ready} onClick={() => controllerRef.current?.resetView()} aria-label="重置相机视角" title="返回全景，退出跟随"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" /><path d="M10 2v2m0 12v2M2 10h2m12 0h2" /></svg><span>视角</span></button>
            <button className="eco-control-button eco-toon-button" type="button" disabled={!ready} onClick={() => controllerRef.current?.setToon(!snapshot.toon)} aria-pressed={snapshot.toon} aria-label="卡通渲染" title={snapshot.toon ? '关闭卡通渲染' : '开启卡通渲染'}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2 7 4v8l-7 4-7-4V6Zm0 0v8m7-4-7 4-7-4m7 4v8" /><path d="m7 4 7 4" /></svg><span className="eco-toon-full-label">卡通渲染</span><span className="eco-toon-short-label" aria-hidden="true">卡通</span></button>
            <div className="eco-notes-anchor"><button className="eco-control-button eco-notes-button" onClick={() => setShowFieldNotes((value) => !value)} aria-label="生态手记" aria-expanded={showFieldNotes} aria-controls="eco-field-notes"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3h10v14H5zM8 7h4m-4 3h4m-4 3h2" /></svg><span>生态手记</span></button>
              {showFieldNotes && <div id="eco-field-notes" className="eco-field-notes"><div><small>NOTES FROM THE FIELD</small><button aria-label="关闭生态手记" onClick={() => setShowFieldNotes(false)}>×</button></div><h2>每一位，都有自己的偏爱。</h2><p><i className="eco-habitat-water" /><span><b>循水而行</b>水系偏爱溪流与浅滩，其他伙伴沿河岸和小桥往来。</span></p><p><i className="eco-habitat-grass" /><span><b>各寻其所</b>林荫、花野与暖石，吸引不同属性的访客。它们时而慢慢散步，时而加快脚步奔跑。</span></p><p><i className="eco-habitat-family" /><span><b>认出熟悉的伙伴</b>同一进化家族更容易靠近，遇见时会停下交流，倦了也会相伴入睡。</span></p><p><i className="eco-habitat-time" /><span><b>跟着天光呼吸</b>黄昏时，伙伴们会聚在一起安睡；夜行的访客则更爱趁着暮色探索。</span></p><p className="eco-follow-note">点击头像，视角会一直跟着它。跟随时仍可环绕、缩放；点击「视角」返回全景。</p></div>}
            </div>
            <span className="eco-control-divider" />
            <button className="eco-control-button eco-reset-button" disabled={!ready || snapshot.count + snapshot.pending === 0} onClick={reset} aria-label="一键清空所有宝可梦" title="清空伙伴，重新开始"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 3h4M6 6l1 11h6l1-11M9 9v5m2-5v5" /></svg><span>清空 <small>RESET</small></span></button>
          </div>
        </div>

        <section className="eco-observer" aria-label="生态观察记录">
          <div className="eco-observer-detail">
            {selected && selectedEntry ? <><img className="eco-observed-icon" src={`${assetBase}models/${selected.pokemonId}/icon.png`} alt="" /><div className="eco-observed-info"><small>{snapshot.followingId === selected.uid ? '正在跟随' : '正在观察'} <span>NO. {selected.pokemonId}</span></small><div><b>{selected.name}</b><span className="eco-state-tag">{selected.label}</span></div><p>原比例 × 0.9<span>·</span>{selectedEntry.types.map((type) => typeThemes[type].label).join(' / ')}</p></div><button className="eco-pet-button" onClick={() => controllerRef.current?.petPokemon(selected.uid)} disabled={snapshot.paused} title={snapshot.paused ? '继续模拟后可以摸摸它' : '靠近这位伙伴，向它打个招呼'}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17 3.5 10.5a4 4 0 0 1 5.7-5.6l.8.8.8-.8a4 4 0 0 1 5.7 5.6Z" /></svg>摸摸它</button></> : <><span className="eco-observer-leaf"><LeafIcon /></span><div className="eco-observed-info"><small>OBSERVATION JOURNAL</small><b>{snapshot.count ? '每一次相遇，都值得停留。' : '把一点生机，交给自然。'}</b><p>{snapshot.count ? '点击场景中的伙伴，读懂它的此刻。' : '水系亲近溪流，同族结伴，伙伴各有所爱。'}</p></div></>}
          </div>
          {snapshot.agents.length > 0 ? <div className="eco-residents" aria-label="场景中的宝可梦，点击观察">
            {snapshot.agents.map((agent, index) => <button key={agent.uid} onClick={() => controllerRef.current?.focusPokemon(agent.uid)} aria-label={`观察${agent.name}，第${index + 1}位伙伴，${agent.label}`} aria-pressed={agent.uid === snapshot.selectedId} title={`跟随${agent.name} · ${agent.label}`}><img src={`${assetBase}models/${agent.pokemonId}/icon.png`} alt="" /></button>)}
          </div> : <div className="eco-habitat-legend" aria-label="场景栖息地"><span><i className="eco-habitat-water" />溪流浅滩</span><span><i className="eco-habitat-grass" />林间花野</span><span><i className="eco-habitat-family" />同族相伴</span></div>}
        </section>
        <div className="eco-journal" aria-label="最近生态动态"><span>林间见闻</span><div>{snapshot.events.length ? snapshot.events.slice(0, 3).map((event) => <p key={event.id}>{event.text}</p>) : <p>风穿过树梢，溪谷正等着新的足迹。</p>}</div></div>
      </main>
    </div>
  </div>;
}
