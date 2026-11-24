/**
 * Outillage de TEST du HUD (jamais importé par le jeu) : un faux `ViewContext` dont les objets (texte, rectangle, image, graphique) mémorisent position, origine, taille et
 * visibilité, avec une estimation de la taille d'un texte (police monospace grasse : 0,6 × la taille par caractère, retour à la ligne au-delà de la largeur de wrap). Permet de
 * construire de VRAIS `PlayerHud` / `TeamPanelHud` sans Phaser et de lire leurs rectangles (`permanentBounds`, `regions`).
 */
import type { ViewContext } from '../entities/common';

/** Largeur d'un caractère, en part de la taille de police (monospace gras). */
const CHAR_RATIO = 0.6;
/** Hauteur d'une ligne de texte, en part de la taille de police (contour compris). */
const LINE_RATIO = 1.3;

/** Objet d'interface factice. Toute méthode inconnue est acceptée (chaînable) : seuls position, origine, taille et visibilité comptent. */
export class FakeGameObject {
  x: number;
  y: number;
  width = 0;
  height = 0;
  scaleX = 1;
  scaleY = 1;
  originX = 0.5;
  originY = 0.5;
  visible = true;
  alpha = 1;
  depth = 0;
  text = '';
  fontSize = 14;
  wrapWidth = 0;
  frame = '';
  destroyed = false;

  constructor(
    readonly kind: 'text' | 'rect' | 'image' | 'graphics',
    x: number,
    y: number,
  ) {
    this.x = x;
    this.y = y;
  }

  get displayWidth(): number {
    return this.width * this.scaleX;
  }
  get displayHeight(): number {
    return this.height * this.scaleY;
  }

  setPosition(x: number, y?: number): this {
    this.x = x;
    if (y !== undefined) this.y = y;
    return this;
  }
  setX(x: number): this {
    this.x = x;
    return this;
  }
  setY(y: number): this {
    this.y = y;
    return this;
  }
  setOrigin(x: number, y?: number): this {
    this.originX = x;
    this.originY = y ?? x;
    return this;
  }
  setSize(w: number, h: number): this {
    this.width = w;
    this.height = h;
    return this;
  }
  setScale(s: number): this {
    this.scaleX = s;
    this.scaleY = s;
    return this;
  }
  setVisible(v: boolean): this {
    this.visible = v;
    return this;
  }
  setAlpha(a: number): this {
    this.alpha = a;
    return this;
  }
  setDepth(d: number): this {
    this.depth = d;
    return this;
  }
  setFrame(f: string): this {
    this.frame = f;
    return this;
  }
  setText(s: string): this {
    this.text = s;
    this.measure();
    return this;
  }
  setWordWrapWidth(w: number): this {
    this.wrapWidth = w;
    this.measure();
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }

  /** Taille estimée d'un texte (retour à la ligne compris). */
  measure(): void {
    if (this.kind !== 'text') return;
    const cw = CHAR_RATIO * this.fontSize;
    const lines = this.text.length === 0 ? [''] : this.text.split('\n');
    let maxW = 0;
    let n = 0;
    for (const line of lines) {
      const w = line.length * cw;
      if (this.wrapWidth > 0 && w > this.wrapWidth) {
        const perLine = Math.max(1, Math.floor(this.wrapWidth / cw));
        n += Math.ceil(line.length / perLine);
        maxW = Math.max(maxW, perLine * cw);
      } else {
        n += 1;
        maxW = Math.max(maxW, w);
      }
    }
    this.width = Math.ceil(maxW);
    this.height = Math.ceil(n * this.fontSize * LINE_RATIO);
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    const w = this.displayWidth;
    const h = this.displayHeight;
    return { x: this.x - this.originX * w, y: this.y - this.originY * h, width: w, height: h };
  }
}

/** Enveloppe qui accepte n'importe quel appel de méthode (setTint, setStrokeStyle, setColor, lineStyle…) et le rend chaînable. */
function lenient(o: FakeGameObject): FakeGameObject {
  return new Proxy(o, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol') return undefined;
      return () => receiver;
    },
  });
}

/** Faux contexte de vue : `scene.add.*` crée des `FakeGameObject`, `rig.registerHud` les mémorise. */
export function makeFakeViewContext(zoom: number, playerCount: number): { ctx: ViewContext; objects: FakeGameObject[] } {
  const objects: FakeGameObject[] = [];
  const keep = (o: FakeGameObject): FakeGameObject => {
    const p = lenient(o);
    objects.push(o);
    return p;
  };
  const scene = {
    add: {
      graphics: () => keep(new FakeGameObject('graphics', 0, 0)),
      text: (x: number, y: number, str: string, style: { fontSize?: string; wordWrap?: { width?: number } }) => {
        const o = new FakeGameObject('text', x, y);
        o.originX = 0;
        o.originY = 0;
        o.fontSize = parseFloat(style.fontSize ?? '14');
        o.wrapWidth = style.wordWrap?.width ?? 0;
        o.text = str;
        o.measure();
        return keep(o);
      },
      rectangle: (x: number, y: number, w: number, h: number) => {
        const o = new FakeGameObject('rect', x, y);
        o.setSize(w, h);
        return keep(o);
      },
      image: (x: number, y: number, _atlas: string, frame: string) => {
        const o = new FakeGameObject('image', x, y);
        o.originX = 0;
        o.originY = 0;
        o.frame = frame;
        o.setSize(8, 8); // les icônes du HUD sont des cases de 8 px (zoomées par `setScale`)
        return keep(o);
      },
    },
  };
  const ctx = {
    scene,
    rig: { registerHud: (o: unknown) => o, registerWorld: (o: unknown) => o },
    zoom,
    playerCount,
  } as unknown as ViewContext;
  return { ctx, objects };
}
