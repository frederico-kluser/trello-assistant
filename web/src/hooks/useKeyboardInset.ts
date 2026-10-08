import { useEffect, useState } from "react";

/**
 * Altura que o teclado virtual comeu da janela, em px (`0` quando não há teclado).
 *
 * Por que `visualViewport` e não `resize` da janela: quando o teclado abre, o
 * layout viewport (e portanto `innerHeight`, `dvh` e o `h-[68dvh]` do palco) NÃO
 * muda — só o visual viewport encolhe. A diferença entre os dois é exatamente a
 * faixa coberta pelo teclado, e é ela que o dock precisa desviar.
 *
 * O limiar de 15% evita tratar como teclado as variações pequenas do visual
 * viewport (barra de endereço entrando/saindo, zoom de pinça), que não pedem
 * deslocamento nenhum.
 */

/** Fração de `innerHeight` acima da qual a diferença conta como teclado aberto. */
export const KEYBOARD_MIN_RATIO = 0.15;

/** Diferença crua entre a janela e o visual viewport, já sem valores negativos. */
export function keyboardInsetPx(innerHeight: number, viewportHeight: number, viewportOffsetTop: number): number {
  if (!Number.isFinite(innerHeight) || !Number.isFinite(viewportHeight) || !Number.isFinite(viewportOffsetTop)) return 0;
  return Math.max(0, innerHeight - viewportHeight - viewportOffsetTop);
}

/** `insetPx` só é diferente de zero quando o teclado cobre mais de 15% da janela. */
export function keyboardInset(innerHeight: number, viewportHeight: number, viewportOffsetTop: number): number {
  if (!(innerHeight > 0)) return 0;
  const inset = keyboardInsetPx(innerHeight, viewportHeight, viewportOffsetTop);
  return inset > innerHeight * KEYBOARD_MIN_RATIO ? Math.round(inset) : 0;
}

export interface KeyboardInset {
  /** Faixa coberta pelo teclado em px (0 = teclado fechado). */
  insetPx: number;
}

export function useKeyboardInset(): KeyboardInset {
  const [insetPx, setInsetPx] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewport = window.visualViewport;
    if (!viewport) return;

    const measure = () => setInsetPx(keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop));
    measure();
    // `scroll` também importa: com o teclado aberto o Safari rola o visual viewport
    // (offsetTop cresce) e a faixa coberta muda sem nenhum resize.
    viewport.addEventListener("resize", measure, { passive: true });
    viewport.addEventListener("scroll", measure, { passive: true });
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, []);

  return { insetPx };
}
