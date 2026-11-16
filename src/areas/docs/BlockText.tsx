/* A textarea that grows with its text: titles, table cells. */
import { forwardRef, useEffect, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

export const BlockText = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function BlockText(props, ref) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = inner.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [props.value]);
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      rows={1}
      spellCheck
      {...props}
      ref={(el) => {
        inner.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
    />
  );
});
