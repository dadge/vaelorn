/**
 * Initialisation commune des tests (vitest `setupFiles`).
 *
 * Les tests de bots enchaînent des dizaines de secondes de calcul synchrone. Entre deux tests, vitest ne rend la main qu'aux micro-tâches :
 * la boucle d'événements du worker n'exécute alors jamais ses callbacks (timers, E/S), et la réponse RPC à `onTaskUpdate` n'est traitée
 * qu'après plus de 60 s → « [vitest-worker]: Timeout calling "onTaskUpdate" », une erreur non gérée qui fait échouer `npm test`
 * (donc le déploiement GitHub Pages) alors que tous les tests passent. On cède donc la main à la boucle d'événements après chaque test.
 */
import { afterEach } from 'vitest';

afterEach(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
