import type { MatchCardId } from '@kpl/shared';

export interface MatchCardDefinition {
  id: MatchCardId;
  name: string;
  imageUrl: string;
}

export const MATCH_CARDS: MatchCardDefinition[] = [
  {
    id: '2vs1',
    name: '2VS1',
    imageUrl: '/cards/match-day/2vs1.webp',
  },
  {
    id: 'restas-tu',
    name: 'Restas tu',
    imageUrl: '/cards/match-day/restas-tu.webp',
  },
  {
    id: 'cambiate',
    name: 'Cambiate',
    imageUrl: '/cards/match-day/cambiate.webp',
  },
  {
    id: 'robo-saque',
    name: 'Robo saque',
    imageUrl: '/cards/match-day/robo-saque.webp',
  },
  {
    id: 'solo-un-saque',
    name: 'Solo un saque',
    imageUrl: '/cards/match-day/solo-un-saque.webp',
  },
  {
    id: 'comodin',
    name: 'Comodin',
    imageUrl: '/cards/match-day/comodin.webp',
  },
  {
    id: 'robo-carta',
    name: 'Robo carta',
    imageUrl: '/cards/match-day/robo-carta.webp',
  },
];

export function findMatchCard(cardId: MatchCardId): MatchCardDefinition | undefined {
  return MATCH_CARDS.find((card) => card.id === cardId);
}
