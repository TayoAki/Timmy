import { PanelLeft, PanelRight, Search } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useStore } from '../state/store';

export interface TabDef {
  id: string;
  label: string;
  count?: number;
}

/** Main column: tab bar on top, scrollable content below. */
export function Frame({
  tabs,
  active,
  onTab,
  children,
  wide,
  scrollKey,
}: {
  tabs: TabDef[];
  active: string;
  onTab: (id: string) => void;
  children: ReactNode;
  wide?: boolean;
  scrollKey?: string;
}) {
  const { dispatch } = useStore();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [scrollKey]);

  return (
    <main className="main">
      <div className="tabs-bar">
        <div className="tabs-actions">
          <button className="icon-btn drawer-only side-toggle" aria-label="Show sidebar" onClick={() => dispatch({ type: 'drawer', drawer: 'side' })}>
            <PanelLeft size={18} />
          </button>
        </div>
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={t.id === active} onClick={() => onTab(t.id)}>
              {t.label}
              {t.count !== undefined && <span className="tab-count">{t.count}</span>}
            </button>
          ))}
        </div>
        <div className="tabs-actions">
          <button className="icon-btn tabs-search" aria-label="Search" onClick={() => dispatch({ type: 'search', open: true })}>
            <Search size={17} />
          </button>
          <button className="icon-btn drawer-only right-toggle" aria-label="Show context panel" onClick={() => dispatch({ type: 'drawer', drawer: 'right' })}>
            <PanelRight size={18} />
          </button>
        </div>
      </div>
      <div className="main-scroll" ref={scroller}>
        <div className={`main-inner${wide ? ' wide' : ''}`}>{children}</div>
      </div>
    </main>
  );
}
