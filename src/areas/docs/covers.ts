/* Built-in page covers: gradients in Timmy's palette. */
import type { DocCover } from '../../data/ws-types';

export const COVERS: { id: string; label: string; css: string }[] = [
  { id: 'indigo', label: 'Indigo', css: 'linear-gradient(135deg, #3f51d9 0%, #7b5ce0 55%, #b07ad8 100%)' },
  { id: 'dawn', label: 'Dawn', css: 'linear-gradient(120deg, #f8d77f 0%, #f6a37b 55%, #ef7e8b 100%)' },
  { id: 'lagoon', label: 'Lagoon', css: 'linear-gradient(120deg, #8ee3c0 0%, #6cc6e0 60%, #5a8fe0 100%)' },
  { id: 'sage', label: 'Sage', css: 'linear-gradient(135deg, #e3ebdc 0%, #b9d0b4 60%, #8fb39a 100%)' },
  { id: 'paper', label: 'Paper', css: 'linear-gradient(135deg, #f6f4ee 0%, #ebe6da 60%, #ddd5c4 100%)' },
  { id: 'dusk', label: 'Dusk', css: 'linear-gradient(135deg, #24263a 0%, #5d4a7a 55%, #d57f62 100%)' },
  { id: 'ocean', label: 'Ocean', css: 'linear-gradient(135deg, #10284f 0%, #1f4f8f 55%, #3b9edb 100%)' },
  { id: 'coral', label: 'Coral', css: 'linear-gradient(120deg, #ffb59f 0%, #ff8a8a 55%, #e25f8b 100%)' },
  { id: 'meadow', label: 'Meadow', css: 'linear-gradient(120deg, #fdf3b0 0%, #b6e0a0 55%, #5fb38a 100%)' },
  { id: 'graphite', label: 'Graphite', css: 'linear-gradient(135deg, #2a2b2f 0%, #4a4c55 60%, #6e7686 100%)' },
];

export const coverStyle = (c: DocCover) =>
  c.kind === 'gradient'
    ? { backgroundImage: COVERS.find((x) => x.id === c.value)?.css ?? COVERS[0]!.css }
    : { backgroundImage: `url("${c.value.replace(/"/g, '%22')}")`, backgroundPosition: `center ${c.y ?? 50}%` };

export const randomCover = (): DocCover => ({ kind: 'gradient', value: COVERS[Math.floor(Math.random() * COVERS.length)]!.id });
