import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Frame } from '../components/Frame';
import { MODES, PALETTES, useTheme, type Palette } from '../state/theme';

const MODE_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

export function AppearanceView() {
  const { mode, palette, systemDark, setMode, setPalette } = useTheme();

  return (
    <Frame tabs={[{ id: 'appearance', label: 'Appearance' }]} active="appearance" onTab={() => {}}>
      <h1 className="page-title">Appearance</h1>
      <p className="page-sub">Choose light or dark, and how dark mode looks. Your choice is saved in this browser.</p>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title" id="mode-label">
            Mode
          </h2>
          {mode === 'system' && <span className="section-sub">Your system is set to {systemDark ? 'dark' : 'light'} right now</span>}
        </div>
        <div className="seg-control seg-control-lg" role="radiogroup" aria-labelledby="mode-label">
          {MODES.map((m) => {
            const Icon = MODE_ICON[m.id];
            return (
              <button key={m.id} role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}>
                <Icon size={15} />
                {m.id === 'system' ? (
                  <>
                    <span className="seg-long">Match system</span>
                    <span className="seg-short">System</span>
                  </>
                ) : (
                  m.name
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title" id="palette-label">
            Dark palette
          </h2>
          <span className="section-sub">Light mode stays the same</span>
        </div>
        <div className="palette-grid" role="radiogroup" aria-labelledby="palette-label">
          {PALETTES.map((p) => (
            <button key={p.id} role="radio" aria-checked={palette === p.id} className="palette-card" onClick={() => setPalette(p.id)}>
              <PalettePreview palette={p.id} />
              <span className="palette-card-text">
                <span className="palette-card-name">
                  {p.name}
                  {palette === p.id && <Check size={15} aria-hidden />}
                </span>
                <span className="palette-card-hint">{p.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </Frame>
  );
}

/** A miniature of the app shell, painted with the palette's own tokens. */
function PalettePreview({ palette }: { palette: Palette }) {
  return (
    <span className="pv" data-theme="dark" data-palette={palette} aria-hidden>
      <span className="pv-rail">
        <i className="pv-logo" />
        <i />
        <i />
      </span>
      <span className="pv-side">
        <i className="pv-nav on" />
        <i className="pv-nav" />
        <i className="pv-nav" />
        <i className="pv-nav short" />
      </span>
      <span className="pv-main">
        <i className="pv-title" />
        <i className="pv-line" />
        <i className="pv-line short" />
        <span className="pv-row">
          <i className="pv-block" />
          <i className="pv-block" />
        </span>
        <i className="pv-button" />
      </span>
    </span>
  );
}
