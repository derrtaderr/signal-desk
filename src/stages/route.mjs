// Stage 4 — route.
//
// Discipline enforced: routing is a deterministic function of the score, it is replayable,
// and every decision carries the reason it was made. Bands are declared in config, highest
// first, and the first band the score clears wins.
//
// Two refusals rather than one fallback. Below the floor is a decision not to pursue. Above
// the floor with no matching band is a configuration hole, and inventing an owner to paper
// over it would put a lead in someone's queue on no authority at all.

import { pass, refuse } from '../contract.mjs';

export const route = {
  name: 'route',

  run(lead, ctx) {
    const config = ctx.config.route ?? {};
    const floor = config.floor ?? 0;
    const bands = config.bands ?? [];
    const total = lead.score.total;

    if (total < floor) {
      return refuse({
        reason: 'BELOW_ROUTING_FLOOR',
        detail: `score ${total} is below the routing floor of ${floor}`,
      });
    }

    const band = bands.find((candidate) => total >= candidate.min);
    if (band === undefined) {
      return refuse({
        reason: 'NO_MATCHING_BAND',
        detail: `score ${total} cleared the floor of ${floor} but matched none of the ${bands.length} configured bands`,
      });
    }

    return pass({
      output: {
        ...lead,
        route: {
          band: band.name,
          owner: band.owner,
          play: band.play,
          reason: `score ${total} cleared the ${band.name} band minimum of ${band.min}`,
        },
      },
    });
  },
};
