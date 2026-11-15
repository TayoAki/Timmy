import { Quote } from 'lucide-react';
import type { Slide } from '../../data/ws-types';

const bars = (seed: string) => {
  let h = 7;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [0, 1, 2, 3, 4].map((i) => 30 + ((h >>> (i * 3)) % 7) * 10);
};

/**
 * A small drawing of a slide, with its real title and bullets. `bare` draws
 * lines instead of text, for strips too small to read.
 */
export function SlideThumb({ slide, bare }: { slide: Pick<Slide, 'id' | 'title' | 'layout' | 'bullets'>; bare?: boolean }) {
  const t = (cls: string, text: string) => (bare ? <span className={`deck-t-line ${cls}`} /> : <span className={cls}>{text}</span>);
  return (
    <div className={`deck-thumb deck-thumb-${slide.layout}${bare ? ' bare' : ''}`} aria-hidden>
      {slide.layout === 'title' && (
        <>
          {t('deck-t-title', slide.title)}
          <span className="deck-t-rule" />
        </>
      )}
      {slide.layout === 'bullets' && (
        <>
          {t('deck-t-head', slide.title)}
          <ul className="deck-t-list">
            {(slide.bullets?.filter((b) => b.trim()).length ? slide.bullets.filter((b) => b.trim()) : ['', '']).slice(0, 3).map((b, i) => (
              <li key={i}>{b && !bare ? b : <span className="deck-t-line" />}</li>
            ))}
          </ul>
        </>
      )}
      {slide.layout === 'chart' && (
        <>
          {t('deck-t-head', slide.title)}
          <div className="deck-t-bars">
            {bars(slide.id + slide.title).map((h, i) => (
              <i key={i} style={{ height: `${h}%` }} />
            ))}
          </div>
        </>
      )}
      {slide.layout === 'quote' && (
        <>
          <Quote size={bare ? 10 : 16} className="deck-t-mark" />
          {t('deck-t-quote', slide.title)}
        </>
      )}
    </div>
  );
}
