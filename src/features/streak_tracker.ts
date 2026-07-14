import type { StudentProfile } from '../types/student';

export function getStreakMessage(profile: StudentProfile, newStreak: number): string | null {
  if (newStreak === 1 && profile.studyStreak === 0) return null; // First time

  if (newStreak === 3) {
    return `🔥 3-day streak! You're building momentum. Keep going!`;
  }
  if (newStreak === 7) {
    return `🔥🔥 One week strong! A whole week of showing up. That's how you actually learn — consistency beats cramming every time.`;
  }
  if (newStreak === 14) {
    return `🏆 Two weeks straight. Honestly? Most people give up before this. You're not most people.`;
  }
  if (newStreak === 30) {
    return `🌟 30 days. That's a habit now. You've changed how you study — for good.`;
  }
  if (newStreak > 0 && newStreak % 10 === 0) {
    return `🔥 ${newStreak}-day streak! You've been showing up for ${newStreak} days straight. Respect.`;
  }

  // Streak broken — be gentle
  if (profile.studyStreak >= 3 && newStreak === 1) {
    return `Welcome back! Your ${profile.studyStreak}-day streak ended but starting again is what matters. Let's go.`;
  }

  return null;
}

export function getNightOwlMessage(hour: number): string | null {
  if (hour >= 23 || hour < 4) {
    return '(It\'s late — studying this hour takes real dedication. Don\'t forget to rest too.)';
  }
  return null;
}

export function getBeforeExamMessage(profile: StudentProfile): string | null {
  const today = new Date();
  const hour = today.getHours();

  for (const target of profile.examTargets) {
    if (!target.examDate) continue;

    const daysLeft = Math.ceil((target.examDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

    if (daysLeft === 0 && hour < 12) {
      const strengths = Object.entries(profile.conceptProgress)
        .filter(([, cp]) => cp.masteryLevel > 0.7)
        .map(([k]) => k)
        .slice(0, 3);

      return `It's exam day. Take a breath. You know ${strengths.length > 0 ? strengths.join(', ') + ' and more' : 'more than you think'}. Start with the questions you know cold. Breathe. Go.`;
    }
  }

  return null;
}