import axios from 'axios';
import { logger } from '../middleware/logger';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchBrave(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      params: { q: query, count: 5, search_lang: 'en' },
      timeout: 8_000,
    });

    return (response.data.web?.results ?? []).map(
      (r: { title: string; url: string; description: string }) => ({
        title: r.title,
        url: r.url,
        snippet: r.description || '',
      })
    );
  } catch (err) {
    logger.warn({ err }, '[Search] Brave failed');
    return [];
  }
}

export async function searchTavily(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await axios.post(
      'https://api.tavily.com/search',
      { api_key: apiKey, query, search_depth: 'basic', max_results: 5 },
      { timeout: 10_000 }
    );

    return (response.data.results ?? []).map(
      (r: { title: string; url: string; content: string }) => ({
        title: r.title,
        url: r.url,
        snippet: (r.content || '').slice(0, 300),
      })
    );
  } catch (err) {
    logger.warn({ err }, '[Search] Tavily failed');
    return [];
  }
}

/**
 * Curriculum-oriented web search. examBoard is optional and only appended
 * when the student profile has discovered one — never a hardcoded default.
 */
export async function searchForCurriculum(
  query: string,
  examBoard?: string | null
): Promise<string> {
  const fullQuery = [examBoard, query, 'syllabus curriculum objectives']
    .filter(Boolean)
    .join(' ');
  const [brave, tavily] = await Promise.allSettled([
    searchBrave(fullQuery),
    searchTavily(fullQuery),
  ]);

  const results = [
    ...(brave.status === 'fulfilled' ? brave.value : []),
    ...(tavily.status === 'fulfilled' ? tavily.value : []),
  ].slice(0, 5);

  if (results.length === 0) return '';
  return results.map((r, i) => `[${i + 1}] ${r.title}: ${r.snippet}`).join('\n\n');
}

/**
 * Live past-exam resource discovery. examBoard optional.
 * Does NOT serve from a static uploaded bank.
 */
export async function findPastExamQuestions(
  topic: string,
  examBoard?: string | null
): Promise<string> {
  const query = [examBoard, 'past questions', topic, 'exam practice']
    .filter(Boolean)
    .join(' ');
  const results = await searchBrave(query);
  if (results.length === 0) {
    const tavily = await searchTavily(query);
    if (tavily.length === 0) return '';
    return `Past exam resources:\n${tavily
      .slice(0, 3)
      .map(r => `- ${r.title}: ${r.snippet}`)
      .join('\n')}`;
  }
  return `Past exam resources:\n${results
    .slice(0, 3)
    .map(r => `- ${r.title}: ${r.snippet}`)
    .join('\n')}`;
}
