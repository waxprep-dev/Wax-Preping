import type { CulturalContext } from '../types/student';
import { logger } from '../middleware/logger';

const COUNTRY_CONFIGS: Record<string, Partial<CulturalContext>> = {
  '+234': { country: 'Nigeria', currency: 'Naira', examBoards: ['WAEC', 'JAMB', 'NECO', 'Post-UTME'], timezone: 'Africa/Lagos' },
  '+254': { country: 'Kenya', currency: 'Shilling', examBoards: ['KCSE', 'KNEC'], timezone: 'Africa/Nairobi' },
  '+233': { country: 'Ghana', currency: 'Cedi', examBoards: ['WASSCE', 'BECE'], timezone: 'Africa/Accra' },
  '+27': { country: 'South Africa', currency: 'Rand', examBoards: ['NSC', 'IEB'], timezone: 'Africa/Johannesburg' },
  '+256': { country: 'Uganda', currency: 'Shilling', examBoards: ['UACE', 'UCE'], timezone: 'Africa/Kampala' },
};

const NIGERIAN_PIDGIN_MARKERS = ['dey', 'abi', 'sha', 'oya', 'wahala', 'abeg', 'wetin', 'naija', 'dem', 'sabi', 'joor', 'ehn', 'sef', 'oga'];

export function detectCulturalContext(
  phoneNumber: string,
  recentMessages: string[]
): CulturalContext {
  // Detect country from phone prefix
  let config: Partial<CulturalContext> = COUNTRY_CONFIGS['+234']; // Default Nigeria

  for (const [prefix, conf] of Object.entries(COUNTRY_CONFIGS)) {
    if (phoneNumber.startsWith(prefix)) {
      config = conf;
      break;
    }
  }

  // Detect language from messages
  const combinedMessages = recentMessages.join(' ').toLowerCase();
  const pidginCount = NIGERIAN_PIDGIN_MARKERS.filter(m => combinedMessages.includes(m)).length;
  const language = pidginCount >= 2 ? 'Pidgin English' : 'English';

  // Infer region from topics/expressions
  let region = 'unknown';
  if (/lagos|vi|mainland|surulere|ikeja/.test(combinedMessages)) region = 'Lagos';
  else if (/abuja|fct|garki|wuse/.test(combinedMessages)) region = 'Abuja';
  else if (/imo|anambra|onitsha|owerri/.test(combinedMessages)) region = 'Southeast Nigeria';
  else if (/kano|kaduna|sokoto|northern/.test(combinedMessages)) region = 'Northern Nigeria';

  // Cultural references based on context
  const culturalReferences = config.country === 'Nigeria'
    ? ['market trading', 'NEPA/generator', 'danfo bus', 'Lagos traffic', 'suya stand', 'football viewing center']
    : [];

  return {
    country: config.country || 'Nigeria',
    region,
    language,
    currency: config.currency || 'Naira',
    examBoards: config.examBoards || ['WAEC', 'JAMB'],
    culturalReferences,
    timezone: config.timezone || 'Africa/Lagos',
  };
}

export function generateCulturalAnalogy(
  concept: string,
  culturalContext: CulturalContext,
  analogyDomains: string[]
): string {
  const nigeriaAnalogies: Record<string, string[]> = {
    'ratio': [
      'When you mix garri with water, the amount of garri to water is a ratio.',
      'If you sell 3 oranges for 100 naira, that\'s your unit ratio.',
      'Suya stick has a ratio of meat to spice. Change that ratio, change the taste.',
    ],
    'current': [
      'Electricity from NEPA flows through the wire like water through a pipe.',
      'The current in your circuit is like the number of customers walking through your shop per minute.',
    ],
    'velocity': [
      'A danfo going from Oshodi to CMS at 80km/h — that\'s velocity. Direction matters.',
      'A bike rider overtaking in traffic — you know both the speed and the direction. That\'s velocity.',
    ],
    'probability': [
      'If NEPA brings light 3 out of 7 days, the probability of light today is 3/7.',
      'Out of 10 times you guess someone will call, you\'re right 4 times. That\'s a 0.4 probability.',
    ],
    'osmosis': [
      'When you soak dried fish in water, water enters the fish cells because the cell has more salt inside. That\'s osmosis.',
    ],
    'force': [
      'When you push a loaded wheelbarrow, you\'re applying force. More load = more force needed.',
      'A keke napep engine produces force to move. The heavier the passengers, the more force required.',
    ],
  };

  const conceptLower = concept.toLowerCase();
  for (const [key, analogies] of Object.entries(nigeriaAnalogies)) {
    if (conceptLower.includes(key)) {
      return analogies[Math.floor(Math.random() * analogies.length)];
    }
  }

  // Generic cultural anchor
  if (culturalContext.country === 'Nigeria') {
    return `Think of ${concept} the same way you'd think about managing a small business in Lagos — every decision has a cost and a benefit.`;
  }

  return '';
}