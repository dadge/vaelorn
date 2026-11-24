/**
 * Interface propre à une partie RÉSEAU (en plus du HUD du joueur local) : message d'état de la liaison (« En attente de l'hôte… », « Connexion instable… ») et petit bandeau d'équipe
 * (nom, PV ou « à terre » des AUTRES joueurs : l'écran n'a qu'une vue, il n'y a pas de panneau d'équipe, docs/NET.md § 7.2). Pur rendu : la logique (entrées du bandeau, état de la
 * liaison) est dans `netGame.ts`. Tous les textes passent par `t()`.
 */
import type Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH, PLAYER_COLORS } from '../core/constants';
import type { GameState } from '../core/types';
import type { ViewContext } from '../entities/common';
import { t } from '../i18n/i18n';
import { HUD_DEPTH, hudRect, hudText, setTextIfChanged } from '../render/hud';
import { teamStripEntries, type NetStall, type TeamStripEntry } from './netGame';

type Text = Phaser.GameObjects.Text;
type Rect = Phaser.GameObjects.Rectangle;

/** Période (ms de rendu) de rafraîchissement du bandeau d'équipe. */
const STRIP_REFRESH_MS = 200;
/** Au plus 3 autres joueurs. */
const STRIP_MAX = 3;

export class NetGameHud {
  private readonly statusText: Text;
  private readonly statusBg: Rect;
  private readonly strip: Text[] = [];
  private stall: NetStall = 'ok';
  private accumMs = STRIP_REFRESH_MS;

  constructor(
    ctx: ViewContext,
    private readonly localPlayerId: number,
    private readonly names: readonly string[],
  ) {
    const cx = GAME_WIDTH / 2;
    this.statusBg = hudRect(ctx, cx, 150, 10, 10, 0x14121f, 0.82, HUD_DEPTH.banner);
    this.statusBg.setVisible(false);
    this.statusText = hudText(ctx, cx, 150, '', { size: 22, originX: 0.5, originY: 0.5, color: 0xffe08a, depth: HUD_DEPTH.banner + 1, align: 'center' });
    this.statusText.setVisible(false);
    for (let i = 0; i < STRIP_MAX; i++) {
      const tx = hudText(ctx, cx, GAME_HEIGHT - 8 - i * 20, '', { size: 15, originX: 0.5, originY: 1, depth: HUD_DEPTH.content });
      tx.setVisible(false);
      this.strip.push(tx);
    }
  }

  /** Message de liaison : rien quand tout va bien. */
  setStall(stall: NetStall): void {
    if (stall === this.stall) return;
    this.stall = stall;
    this.refreshStatus();
  }

  private refreshStatus(): void {
    const key = this.stall === 'waiting' ? 'net.game.waiting' : this.stall === 'lag' ? 'net.game.lag' : null;
    if (key === null) {
      this.statusText.setVisible(false);
      this.statusBg.setVisible(false);
      return;
    }
    this.statusText.setText(t(key)).setVisible(true);
    this.statusBg.setSize(this.statusText.width + 28, this.statusText.height + 14).setVisible(true);
  }

  /** Bandeau d'équipe : les autres joueurs, une ligne chacun, en bas au centre de l'écran (le HUD du joueur local est en haut, les commandes tactiles dans les coins). */
  update(state: GameState, connectedMask: number | null, dtMs: number): void {
    this.accumMs += dtMs;
    if (this.accumMs < STRIP_REFRESH_MS) return;
    this.accumMs = 0;
    const entries = teamStripEntries(state, this.localPlayerId, this.names, connectedMask);
    for (let i = 0; i < this.strip.length; i++) this.paint(this.strip[i], entries[i]);
  }

  private paint(text: Text, e: TeamStripEntry | undefined): void {
    if (!e) {
      text.setVisible(false);
      return;
    }
    const status = e.down ? t('hud.down') : `${t('hud.hp')} ${e.hp}/${e.maxHp}`;
    setTextIfChanged(text, `${e.name}  ${status}`);
    text.setColor(e.lost ? '#8a8aa0' : e.down ? '#ff6a6a' : `#${PLAYER_COLORS[e.id].toString(16).padStart(6, '0')}`);
    text.setVisible(true);
  }

  /** Changement de langue : on relit les textes au prochain rafraîchissement. */
  retranslate(): void {
    this.accumMs = STRIP_REFRESH_MS;
    this.refreshStatus();
  }

  destroy(): void {
    this.statusText.destroy();
    this.statusBg.destroy();
    for (const s of this.strip) s.destroy();
    this.strip.length = 0;
  }
}
