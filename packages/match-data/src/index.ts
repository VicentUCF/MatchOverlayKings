export * from './league-data.js';
export * from './sponsors.js';
export * from './match-cards.js';
import type { Team } from '@kpl/shared';
export interface TeamRow { id:string; name:string; short_name:string; logo_url:string; primary_color:string; secondary_color:string }
export function mapTeams(rows:readonly TeamRow[]):Team[]{return rows.map(t=>({id:t.id,name:t.name,shortName:t.short_name,logoUrl:t.logo_url,primaryColor:t.primary_color,secondaryColor:t.secondary_color}));}
