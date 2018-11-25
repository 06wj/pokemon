import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

interface HeaderProps { onHome(): void; }

export function Header({ onHome }: HeaderProps) {
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };
  return (
    <header className="topbar">
      <a className="brand" href="#001" aria-label="回到第一只宝可梦" onClick={(event) => { event.preventDefault(); onHome(); }}>
        <span className="brand-mark" aria-hidden="true"><i></i></span>
        <span><b>NATURA<span>®</span></b><small>宝可梦 · 生态藏馆</small></span>
      </a>
      <div className="top-meta"><span>一方微景，万物有灵。</span><small>THE POKÉMON HABITAT COLLECTION</small></div>
      <div className="top-actions"><span>关都篇 <i>VOL. 01</i></span><button className="icon-button" onClick={toggleFullscreen} aria-label="全屏展示" title="全屏展示">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/></svg>
      </button></div>
    </header>
  );
}

interface ControlsProps {
  autoRotate: boolean;
  animations: readonly { name: string; label: string }[];
  animation: string;
  animationDisabled: boolean;
  onAnimationChange(name: string): void;
  onPrevious(): void;
  onNext(): void;
  onToggleRotate(): void;
  onReset(): void;
}

function AnimationPicker({ animations, animation, animationDisabled, onAnimationChange }: Pick<ControlsProps, 'animations' | 'animation' | 'animationDisabled' | 'onAnimationChange'>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const disabled = animationDisabled || animations.length === 0;
  const label = animations.find((item) => item.name === animation)?.label ?? '待机';

  useEffect(() => { setOpen(false); }, [disabled, animations]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);

  const close = (): void => { setOpen(false); trigger.current?.focus(); };
  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div className="animation-picker" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <button ref={trigger} className="animation-trigger" type="button" disabled={disabled}
        aria-label={`当前动作：${label}`} aria-haspopup="menu" aria-expanded={open && !disabled}
        aria-controls={open && !disabled ? menuId : undefined} title="切换宝可梦动作"
        onClick={() => setOpen((value) => !value)} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
          if (event.key === 'Escape') close();
        }}>
        <span>{label}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 9 3-3 3 3"/></svg>
      </button>
      {open && !disabled && <div className="animation-popover" id={menuId} role="menu" aria-label="选择动作" onKeyDown={menuKeyDown}>
        <span className="animation-popover-label" aria-hidden="true">选择动作</span>
        <div className="animation-options" role="none">
          {animations.map((item) => <button type="button" key={item.name} role="menuitemradio"
            aria-checked={item.name === animation} tabIndex={-1}
            onClick={() => { onAnimationChange(item.name); close(); }}>
            <span>{item.label}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8 3 3 5-6"/></svg>
          </button>)}
        </div>
      </div>}
    </div>
  );
}

export function ViewerControls({ autoRotate, animations, animation, animationDisabled, onAnimationChange, onPrevious, onNext, onToggleRotate, onReset }: ControlsProps) {
  return (
    <div className="viewer-toolbar" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <AnimationPicker animations={animations} animation={animation} animationDisabled={animationDisabled} onAnimationChange={onAnimationChange} />
      <span className="toolbar-divider" aria-hidden="true"></span>
    <nav className="viewer-controls" aria-label="模型浏览控制">
      <button className="previous-pokemon" onClick={onPrevious} aria-label="上一只" title="上一只（←）"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m11.5 5-5 5 5 5M7 10h8"/></svg></button>
      <span className="control-divider"></span>
      <button className={`rotate-toggle${autoRotate ? ' active' : ''}`} onClick={onToggleRotate} aria-pressed={autoRotate} aria-label="自动环绕视角" title="自动环绕视角"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.7 6A7 7 0 0 0 3.1 10m1.2 4A7 7 0 0 0 16.9 10M15.7 2.5V6h-3.5M4.3 17.5V14h3.5"/></svg><span>自动环绕</span></button>
      <button className="reset-view" onClick={onReset} aria-label="重置视角" title="重置视角（R）"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4"/><path d="M10 2v2m0 12v2M2 10h2m12 0h2"/></svg></button>
      <span className="control-divider"></span>
      <button className="next-pokemon" onClick={onNext} aria-label="下一只" title="下一只（→）"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8.5 5 5 5-5 5M13 10H5"/></svg></button>
    </nav>
    </div>
  );
}
