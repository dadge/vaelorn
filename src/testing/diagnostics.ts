/**
 * Diagnostic textuel d'une partie de bots : à inclure dans le message d'échec d'un test (timeout de salle, action échouée)
 * pour comprendre en un coup d'œil où en est chaque joueur, quels ennemis restent, quels mécanismes sont actifs.
 */
import { TILE } from '../core/constants';
import type { MechanismDef, MechanismState } from '../core/types';
import type { BotRun } from './botKit';

function r1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function describeWhere(def: MechanismDef): string {
  switch (def.type) {
    case 'door':
      return `tuiles ${def.tiles.map((t) => t.join(',')).join(' ')}`;
    case 'runePuzzle':
      return `affichage ${def.displayTile.join(',')}`;
    case 'statuePair':
      return `statues ${def.statues.map((s) => `${s.tile.join(',')} (socle ${s.standTile.join(',')})`).join(' / ')}`;
    case 'hourglass':
      return `leviers ${def.levers.map((t) => t.join(',')).join(' ')}, herse ${def.gate.map((t) => t.join(',')).join(' ')}`;
    case 'lightBridge':
      return `pont ${def.tiles.map((t) => t.join(',')).join(' ')} (lanterne slot ${def.lanternSlot}, rayon ${def.radiusTiles})`;
    default:
      return `tuile ${def.tile.join(',')}`;
  }
}

function describeMechanism(def: MechanismDef, st: MechanismState | undefined): string {
  if (!st) return `${def.id} (${def.type}) : état absent`;
  const flags: string[] = [];
  if (st.waived) flags.push('neutralisé (minPlayers)');
  switch (st.type) {
    case 'plate':
      flags.push(st.active ? `pressée par ${st.pressedBy === null ? '?' : st.pressedBy === 'block' ? 'un bloc' : `J${Number(st.pressedBy) + 1}`}` : 'libre');
      break;
    case 'lever':
      flags.push(st.active ? `actif${st.remainingMs > 0 ? ` (reste ${Math.round(st.remainingMs)} ms)` : ' (verrouillé)'}` : 'inactif');
      break;
    case 'key':
      flags.push(st.active ? 'utilisée' : st.collected ? `portée par J${(st.holderId ?? 0) + 1}` : 'au sol');
      break;
    case 'door':
      flags.push(st.open ? 'ouverte' : 'fermée');
      if (!st.open && def.type === 'door') flags.push(`exige [${def.requires.join(', ')}]${def.keyId ? ` + clé ${def.keyId}` : ''}`);
      break;
    case 'block':
      flags.push(`tuile ${st.tile.join(',')}${st.moving ? ` → en mouvement ${Math.round(st.moving.progress * 100)} %` : ''}`);
      break;
    case 'socket':
      flags.push(st.active ? 'rempli' : 'vide');
      break;
    case 'runePuzzle':
      flags.push(st.active ? 'résolue' : `progression ${st.progress}${def.type === 'runePuzzle' ? `/${def.sequence.length}` : ''}`);
      break;
    case 'statuePair':
      flags.push(st.active ? 'résolues' : 'non résolues', `statues [${st.facings.join(', ')}]${def.type === 'statuePair' ? ` → cible ${def.targetDir}` : ''}`);
      break;
    case 'hourglass':
      flags.push(
        st.sandMs > 0 ? `sable ${Math.round(st.sandMs)} ms` : 'sable VIDE',
        `herse ${st.closedCount}/${def.type === 'hourglass' ? def.gate.length : '?'} fermée(s)`,
      );
      break;
    case 'lightBridge':
      flags.push(`porteur ${st.bearerId === null ? 'aucun' : `J${st.bearerId + 1}`}`, `éclairé [${st.lit.map((l) => (l ? '1' : '0')).join('')}]`);
      break;
  }
  const where = describeWhere(def);
  return `${def.id} (${st.type}, ${where}) : ${flags.join(', ')}`;
}

/**
 * Rapport texte lisible de l'état d'une partie de bots : salle, phase, temps ; pour chaque joueur position/PV/état/action
 * en cours/file d'attente ; ennemis restants ; mécanismes ; objectifs ; sortie ; échecs d'actions ; derniers événements
 * et traces.
 * @param run partie de bots
 * @param reason raison de l'échec à afficher en tête (optionnel)
 */
export function diagnoseRun(run: BotRun, reason?: string): string {
  const s = run.sim.state;
  const room = run.sim.room;
  const lines: string[] = [];
  lines.push('══════ DIAGNOSTIC BOTS ══════');
  if (reason) lines.push(`Raison : ${reason}`);
  lines.push(
    `Niveau « ${run.level.id} », salle #${s.roomIndex} « ${room.id} » (${s.roomIndex + 1}/${run.level.rooms.length}), phase ${s.phase}, ` +
      `temps total ${secs(s.timeMs)}, temps dans la salle ${secs(s.room.elapsedMs)}, tick ${s.tick}, ${s.playerCount} joueur(s)`,
  );
  lines.push('— Joueurs —');
  for (const bot of run.bots) {
    const p = s.players[bot.id];
    const tile = `${Math.floor(p.pos.x / TILE)},${Math.floor(p.pos.y / TILE)}`;
    const act = bot.currentLabel ?? '(aucune action)';
    lines.push(
      `  J${p.id + 1} ${p.characterId} diff ${p.difficulty} : ${p.status === 'alive' ? 'debout' : 'À TERRE'} PV ${p.hp}/${p.maxHp} ` +
        `pos px ${r1(p.pos.x)},${r1(p.pos.y)} tuile ${tile} face ${p.facing} clés [${p.keys.join(',')}] ` +
        `relève ${p.revivingId === null ? '-' : `J${p.revivingId + 1}`} | action : ${act} (+${bot.queued} en file)`,
    );
  }
  lines.push(`— Ennemis (${run.aliveEnemies.length} vivant(s)) —`);
  for (const e of run.aliveEnemies.slice(0, 20)) {
    let near = Infinity;
    let nearId = '';
    for (const p of s.players) {
      const d = Math.hypot(p.pos.x - e.pos.x, p.pos.y - e.pos.y);
      if (d < near) {
        near = d;
        nearId = `J${p.id + 1}`;
      }
    }
    lines.push(
      `  #${e.id} ${e.kind} PV ${Math.round(e.hp)}/${e.maxHp} pos px ${r1(e.pos.x)},${r1(e.pos.y)} tuile ${Math.floor(e.pos.x / TILE)},${Math.floor(e.pos.y / TILE)} ` +
        `mode ${e.mode} vague ${e.wave} (à ${Math.round(near)} px de ${nearId})`,
    );
  }
  if (run.aliveEnemies.length > 20) lines.push(`  … et ${run.aliveEnemies.length - 20} autre(s)`);
  const pending = run.pendingSpawnCount(false);
  if (pending > 0) lines.push(`  (${pending} apparition(s) encore en attente, dont ${run.pendingSpawnCount(true)} imminente(s))`);
  lines.push('— Mécanismes —');
  for (const def of room.mechanisms) {
    lines.push(`  ${describeMechanism(def, s.room.mechanisms.find((m) => m.id === def.id))}`);
  }
  lines.push('— Objectifs —');
  for (const o of s.objectives) {
    const def = run.level.objectives.find((d) => d.id === o.id);
    lines.push(`  ${o.id} (salle ${def?.roomId ?? '?'}, ${def?.kind ?? '?'}) : propriétaire J${o.ownerId + 1}, ${o.done ? 'accompli' : `progression ${Math.round(o.progress * 100)} %`}`);
  }
  const exit = room.exit;
  const reqs = exit.requires.map((q) => `${q}${run.requirementMet(q) ? ' ✓' : ' ✗'}`).join(', ');
  const inExit = s.players
    .filter((p) => p.status === 'alive')
    .map((p) => `J${p.id + 1}:${p.pos.x >= exit.rect.x * TILE && p.pos.x < (exit.rect.x + exit.rect.w) * TILE && p.pos.y >= exit.rect.y * TILE && p.pos.y < (exit.rect.y + exit.rect.h) * TILE ? 'dedans' : 'dehors'}`)
    .join(' ');
  lines.push(
    `— Sortie : rect ${exit.rect.x},${exit.rect.y} ${exit.rect.w}×${exit.rect.h}${exit.final ? ' (finale)' : ''} exige [${reqs}] ; ${run.sim.isExitOpen() ? 'OUVERTE' : 'fermée'} ; joueurs vivants : ${inExit || 'aucun'}`,
  );
  if (run.failures.length > 0) {
    lines.push('— Échecs d\'actions —');
    for (const f of run.failures.slice(-8)) lines.push(`  [${secs(f.timeMs)}] J${f.playerId + 1} ${f.label} (salle ${f.roomId}) : ${f.reason}`);
  }
  const recent = run.eventLog.slice(-24);
  if (recent.length > 0) {
    lines.push('— Derniers événements —');
    for (const ev of recent) lines.push(`  [${secs(ev.timeMs)}] ${ev.text}`);
  }
  if (run.trace.length > 0) {
    lines.push('— Traces (say) —');
    for (const t of run.trace.slice(-12)) lines.push(`  ${t}`);
  }
  lines.push('═════════════════════════════');
  return lines.join('\n');
}

/**
 * Tableau texte des statistiques de la partie : temps simulé, défaites collectives, par joueur (à terre, PV perdus, relevages,
 * kills) et par salle (temps, entrées, défaites). Sert à estimer difficulté et durée d'un niveau.
 */
export function formatStats(run: BotRun): string {
  const st = run.stats;
  const lines: string[] = [];
  lines.push(`Temps simulé : ${secs(st.timeMs)} — défaites collectives : ${st.wipes}`);
  st.players.forEach((p, i) => {
    lines.push(
      `  J${i + 1} ${run.sim.state.players[i].characterId} : à terre ${p.downs} fois, PV perdus ${Math.round(p.hpLost)}, relevages faits ${p.revivesDone}, relevé ${p.revivedTimes} fois, kills ${p.kills}`,
    );
  });
  for (const r of st.rooms) {
    lines.push(
      `  salle #${r.roomIndex} ${r.roomId} : ${secs(r.timeMs)}, ${r.entries} entrée(s), ${r.wipes} défaite(s), validée ${r.clearedAtMs === null ? 'non' : `à ${secs(r.clearedAtMs)}`}, ` +
        `à terre [${r.downs.join(',')}], PV perdus [${r.hpLost.map((h) => Math.round(h)).join(',')}]`,
    );
  }
  return lines.join('\n');
}
