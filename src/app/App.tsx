import { useCallback, useEffect, useRef, useState } from 'react';
import { DexPanel } from '../components/DexPanel';
import { MaterialPanel } from '../components/MaterialPanel';
import { Header, ViewerControls } from '../components/ViewerChrome';
import type { MaterialKey } from '../content/materials';
import { alternateBackend, backendSwitchUrl, materialFromUrl } from './viewerLocation';
import { pokemon } from '../content/pokemon';
import { getHabitat } from '../content/habitats';
import { typeThemes } from '../content/typeThemes';
import type { PokemonStageController } from '../hilo/PokemonStageController';
import { EcologyScene } from '../components/EcologyScene';

const assetBase = import.meta.env.BASE_URL;

function initialIndex(): number {
  const index = pokemon.findIndex((entry) => entry.id === location.hash.slice(1));
  return index >= 0 ? index : 0;
}

export function App() {
  const [scene, setScene] = useState(() => new URL(location.href).searchParams.get('scene') === 'ecology' ? 'ecology' : 'gallery');
  const switchScene = (next: string): void => {
    const url = new URL(location.href);
    if (next === 'ecology') url.searchParams.set('scene', 'ecology');
    else url.searchParams.delete('scene');
    history.replaceState(null, '', url);
    setScene(next);
  };
  return scene === 'ecology'
    ? <EcologyScene assetBase={assetBase} onBack={() => switchScene('gallery')} />
    : <Gallery onEcology={() => switchScene('ecology')} />;
}

function Gallery({ onEcology }: { onEcology(): void }) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<PokemonStageController | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [material, setMaterial] = useState<MaterialKey>(() => materialFromUrl(location.href));
  const [autoRotate, setAutoRotate] = useState(false);
  const [playback, setPlayback] = useState<{ pokemonId: string | null; animation: string }>({
    pokemonId: null, animation: 'idle',
  });
  const [modelLoading, setModelLoading] = useState(true);
  const [stageReady, setStageReady] = useState(false);
  const [stageError, setStageError] = useState('');
  const [backend, setBackend] = useState('initializing');
  const [switchingBackend, setSwitchingBackend] = useState(false);
  const backendLabel = switchingBackend ? '切换中' : backend === 'webgpu' ? 'WebGPU' : backend === 'webgl2' ? 'WebGL2' : stageError ? '未就绪' : '初始化中';
  const targetBackendLabel = alternateBackend(backend, location.href) === 'webgpu' ? 'WebGPU' : 'WebGL2';
  const selected = pokemon[selectedIndex] ?? pokemon[0]!;
  const primaryType = selected.types[0] ?? 'normal';
  const habitat = getHabitat(selected);
  const displayed = pokemon.find((entry) => entry.id === playback.pokemonId) ?? selected;
  const animationDisabled = modelLoading || !stageReady || Boolean(stageError) || playback.pokemonId !== selected.id;

  const selectRelative = useCallback((offset: number) => {
    setSelectedIndex((current) => (current + offset + pokemon.length) % pokemon.length);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let controller: PokemonStageController | null = null;
    const container = sceneRef.current;
    if (!container) return undefined;
    void import('../hilo/PokemonStageController').then(({ PokemonStageController }) => PokemonStageController.create({
      container,
      assetBase,
      onLoadingChange: setModelLoading,
      onBackend: setBackend,
      onSceneError: setStageError,
      onAnimationChange: (animation, pokemonId) => setPlayback({ pokemonId, animation }),
    })).then((created) => {
      if (cancelled) { created.destroy(); return; }
      controller = created;
      controllerRef.current = created;
      setStageReady(true);
    }).catch((error: unknown) => {
      console.error(error);
      setStageError(error instanceof Error ? error.message : 'Hilo3D 初始化失败');
      setModelLoading(false);
    });
    const resize = (): void => controllerRef.current?.resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    window.addEventListener('resize', resize);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', resize);
      resizeObserver.disconnect();
      controllerRef.current = null;
      controller?.destroy();
    };
  }, []);

  useEffect(() => {
    if (!stageReady) return;
    history.replaceState(null, '', `#${selected.id}`);
    void controllerRef.current?.loadPokemon(selected);
  }, [selected, stageReady]);

  useEffect(() => {
    if (stageReady) controllerRef.current?.setMaterial(material);
  }, [material, stageReady]);

  useEffect(() => {
    document.documentElement.style.setProperty('--type-accent', habitat.accent);
    if (stageReady) controllerRef.current?.setHabitat(habitat.key);
  }, [habitat, stageReady]);

  useEffect(() => {
    controllerRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate, stageReady]);

  const selectAnimation = (name: string): void => {
    if (animationDisabled || !displayed.animations.some((item) => item.name === name)) return;
    controllerRef.current?.setAnimation(name);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const search = document.querySelector<HTMLInputElement>('#dex-search');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        search?.focus();
        return;
      }
      if (document.activeElement?.matches('input, select, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') selectRelative(-1);
      if (event.key === 'ArrowRight') selectRelative(1);
      if (event.key.toLowerCase() === 'r') controllerRef.current?.resetView();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectRelative]);

  return (
    <div className={`app-root type-${primaryType}`} data-renderer={backend}>
      <Header onHome={() => setSelectedIndex(0)} />
      <button className="ecology-entry" onClick={onEcology}><span>✧</span> 河谷生态园 <small>NEW</small><span>↗</span></button>
      <div className="gallery-layout">
        <DexPanel assetBase={assetBase} entries={pokemon} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
        <main className="exhibition" aria-label="宝可梦生态展示">
          <div className="exhibition-heading" aria-live="polite">
            <div className="specimen-info">
              <div className="eyebrow">关都图鉴 <span>/</span> NO. {selected.id}</div>
              <div className="specimen-title">
                <h1>{selected.name}</h1>
                <div className="specimen-tags">
                  {selected.types.map((type) => (
                    <span key={type} style={{ color: typeThemes[type].accent }}>{typeThemes[type].label}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="habitat-info">
              <span className="habitat-label">HABITAT STUDY</span>
              <b><i></i>{habitat.name}</b>
              <p>{habitat.description}</p>
            </div>
          </div>
          <section className="exhibition-stage" aria-label={`${selected.name} · ${habitat.name} · 交互式三维场景`}>
            <div ref={sceneRef} className="scene-canvas" aria-hidden="true"></div>
            <div className="stage-corner stage-corner-top" aria-hidden="true"></div>
            <div className="stage-corner stage-corner-bottom" aria-hidden="true"></div>
            <div className="stage-label"><span>生态微景</span><i></i><small>{habitat.en}</small></div>
            <div className="stage-edition">
              <span aria-hidden="true">FIG. {selected.id}</span>
              <button className="renderer-backend" type="button"
                disabled={switchingBackend || (backend === 'initializing' && !stageError)}
                aria-label={`当前渲染后端：${backendLabel}，切换到 ${targetBackendLabel}`}
                title={`切换到 ${targetBackendLabel}（重新加载，保留宝可梦与材质）`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setSwitchingBackend(true);
                  location.assign(backendSwitchUrl(location.href, backend, selected.id, material));
                }}>
                <span>{backendLabel}</span>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h10m-3-3 3 3-3 3M13 11H3m3-3-3 3 3 3"/></svg>
              </button>
            </div>
            <div className="stage-bottom">
              <div className="interaction-hint"><span className="mouse-icon"></span><span>拖动旋转 <i>·</i> 滚轮缩放</span></div>
              <ViewerControls
                autoRotate={autoRotate}
                animations={displayed.animations}
                animation={playback.animation}
                animationDisabled={animationDisabled}
                onAnimationChange={selectAnimation}
                onPrevious={() => selectRelative(-1)}
                onNext={() => selectRelative(1)}
                onToggleRotate={() => setAutoRotate((value) => !value)}
                onReset={() => controllerRef.current?.resetView()}
              />
            </div>
            <div className={`model-loading${modelLoading ? ' visible' : ''}`} role="status" aria-live="polite">
              {modelLoading && <><span></span><b>正在布置生态微景…</b></>}
            </div>
            {stageError && <div className="stage-error"><b>生态微景暂时无法打开</b><small>{stageError}</small><button onClick={() => location.reload()}>重新加载</button></div>}
          </section>
          <MaterialPanel material={material} onChange={setMaterial} />
          <div className="exhibition-footer"><span>在光与材质之间，重新发现熟悉的伙伴。</span><span>NATURA <i>/</i> KANTO COLLECTION</span></div>
        </main>
      </div>
    </div>
  );
}
