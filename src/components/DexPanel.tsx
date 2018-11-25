import { useEffect, useMemo, useRef, useState } from 'react';
import { catalogueSize, type PokemonEntry } from '../content/pokemon';

interface DexPanelProps {
  assetBase: string;
  entries: readonly PokemonEntry[];
  selectedIndex: number;
  onSelect(index: number): void;
}

export function DexPanel({ assetBase, entries, selectedIndex, onSelect }: DexPanelProps) {
  const [query, setQuery] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLowerCase().replace(/^no\.?/, '');
  const matches = useMemo(() => entries.map((entry) => (
    !normalizedQuery
    || entry.name.toLowerCase().includes(normalizedQuery)
    || entry.id.includes(/^\d+$/.test(normalizedQuery) ? normalizedQuery.padStart(3, '0') : normalizedQuery)
  )), [entries, normalizedQuery]);

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  return (
    <aside className="dex-panel">
      <div className="panel-heading">
        <span><small>THE COLLECTION</small><b>发现伙伴</b></span><em>{entries.length}<small>种</small></em>
      </div>
      <label className="search-box">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
        <input
          id="dex-search"
          type="search"
          aria-label="检索宝可梦名称或图鉴编号"
          placeholder="名称或图鉴编号"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <kbd>⌘ K</kbd>
      </label>
      <div ref={gridRef} className="dex-grid" role="listbox" aria-label="第一世代宝可梦列表">
        {entries.map((entry, index) => matches[index] && (
          <button
            className={`dex-card${index === selectedIndex ? ' active' : ''}`}
            data-index={index}
            key={entry.id}
            role="option"
            aria-selected={index === selectedIndex}
            title={entry.name}
            onClick={() => onSelect(index)}
          >
            <img src={`${assetBase}models/${entry.id}/icon.png`} alt="" loading="lazy" />
            <span><small>{entry.id}</small><b>{entry.name}</b></span>
          </button>
        ))}
        {!matches.some(Boolean) && <div className="dex-empty"><b>还没有找到这位伙伴</b><span>试试其他名称或编号</span><button onClick={() => setQuery('')}>查看全部</button></div>}
      </div>
      <div className="dex-footer"><span><i></i><b>{entries.length}</b> / {catalogueSize} 已收录</span><span>第一世代</span></div>
    </aside>
  );
}
