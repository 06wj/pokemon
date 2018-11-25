import { materialThemes, type MaterialKey } from '../content/materials';

interface MaterialPanelProps {
  material: MaterialKey;
  onChange(key: MaterialKey): void;
}

export function MaterialPanel({ material, onChange }: MaterialPanelProps) {
  const theme = materialThemes.find((item) => item.key === material) ?? materialThemes[0]!;
  return (
    <aside className="material-panel" aria-label="表面材质选择">
      <div className="material-heading">
        <small>SURFACE ATELIER</small>
        <b>触感与光泽</b>
        <p aria-live="polite">{theme.description}</p>
      </div>
      <div className="material-list" role="group" aria-label="选择模型材质">
        {materialThemes.map((item) => (
          <button
            className={`material-card${item.key === material ? ' active' : ''}`}
            data-material={item.key}
            key={item.key}
            onClick={() => onChange(item.key)}
            aria-pressed={item.key === material}
            title={`${item.name} · ${item.description}`}
          >
            <i className="material-swatch" aria-hidden="true"></i>
            <span><b>{item.name}</b><small>{item.en}</small></span>
            <em aria-hidden="true"></em>
          </button>
        ))}
      </div>
    </aside>
  );
}
