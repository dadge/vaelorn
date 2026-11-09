/**
 * Constantes de jeu partagées (logique pure, aucune dépendance à Phaser).
 * Unités : pixels « monde » (1 tuile = 16 px), millisecondes pour les durées.
 */

export const TILE = 16;

/** Pas de simulation fixe : la simulation avance toujours par multiples de ce pas. */
export const SIM_STEP_MS = 1000 / 60;

export const MAX_PLAYERS = 4;

/** Durée nominale du relevage (ms) quand le sauveteur maintient le bouton. */
export const REVIVE_DURATION_MS = 3000;
/** Distance max (centre à centre, px) entre sauveteur et joueur à terre. */
export const REVIVE_RANGE = 22;
/** Un ennemi à moins de ce rayon (px) d'un joueur à terre ralentit le relevage. */
export const DOWNED_THREAT_RADIUS = 20;
/** Multiplicateur de vitesse de relevage quand au moins un ennemi menace le joueur à terre. */
export const REVIVE_THREAT_SLOW = 0.35;

/** Portée d'interaction (px) : leviers, portes à clé, piédestaux, ramassage de clé. */
export const INTERACT_RANGE = 20;

/** Invulnérabilité courte après avoir été touché (ms). */
export const PLAYER_INVULN_MS = 700;
/** Rayon de la hitbox joueur / ennemis standard (px). */
export const PLAYER_RADIUS = 5;

/** Durée (ms) entre « tous à terre » et le redémarrage automatique de la salle. */
export const WIPE_RESTART_DELAY_MS = 2500;
/** Durée (ms) entre « salle terminée » et le chargement de la salle suivante. */
export const ROOM_CLEAR_DELAY_MS = 1800;

/** Taille d'un bloc poussable en tuiles (carré). */
export const BLOCK_SIZE_TILES = 2;
/** Durée (ms) du déplacement d'un bloc d'une tuile. */
export const BLOCK_MOVE_MS = 350;

/** Couleurs des joueurs (J1..J4) — 0xRRGGBB. Utilisées pour marqueurs, HUD, objectifs. */
export const PLAYER_COLORS: readonly number[] = [0x4aa3ff, 0xff5a5a, 0x5be37d, 0xffd84a];
export const PLAYER_COLOR_NAMES: readonly string[] = ['blue', 'red', 'green', 'yellow'];

/** Torche personnelle (salles sombres). Autonomie en ms de jeu passées dans une salle sombre. */
export const TORCH_MAX_MS = 75_000;
/** Sous cette fraction du combustible, la torche faiblit (rayon réduit, alerte HUD). */
export const TORCH_LOW_FRACTION = 0.25;
/** Rayons de lumière en tuiles : torche pleine / faiblissante / éteinte, brasero par défaut. */
export const LIGHT_FULL_TILES = 6;
export const LIGHT_LOW_TILES = 3.5;
export const LIGHT_EMPTY_TILES = 1.75;
export const BRAZIER_LIGHT_TILES = 5;

// ───────────────────────────── Appel (signal sonore à l'équipe) ─────────────────────────────

/** Durée (ms) d'immobilisation de l'appelant au début de l'appel : ni déplacement, ni attaque, ni spécial, ni interaction, ni relevage. */
export const CALL_FREEZE_MS = 1000;
/** Durée (ms) du signal d'appel depuis l'appui (la 1re seconde est celle de l'immobilisation). */
export const CALL_DURATION_MS = 3000;
/** Délai de récupération (ms) mesuré depuis l'APPUI : un nouvel appel n'est possible qu'une fois écoulé (donc 2 s de repos après la fin du signal). */
export const CALL_COOLDOWN_MS = 5000;

/** Résolution logique du canvas (Phaser.Scale.FIT l'adapte à la fenêtre). */
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;
