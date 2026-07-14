import type { StudentProfile } from '../types/student';

export function getExamCountdownMessage(profile: StudentProfile): string | null {
  const today = new Date();

  for (const target of profile.examTargets) {
    if (!target.examDate) continue;

    const daysLeft = Math.ceil((target.examDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

    if (daysLeft < 0) continue; // Exam passed

    if (daysLeft === 0) {
      return `Today is your ${target.examType} exam day! 🎯 You've prepared well. Trust yourself, read every question twice, and start with what you know. Go show them what you've got.`;
    }

    if (daysLeft === 1) {
      return `Tomorrow is your ${target.examType} exam! 📚 Tonight: review your notes lightly, get to sleep by 10pm, eat well tomorrow morning. You're ready. No cramming tonight — trust your work.`;
    }

    if (daysLeft <= 7) {
      const subjects = target.subjects.join(', ');
      return `🗓️ ${daysLeft} days to ${target.examType}. Focus this week: ${subjects}. Do at least one past question per day. Ask me anything you're shaky on.`;
    }

    if (daysLeft <= 30) {
      return `📅 ${daysLeft} days to ${target.examType}. Time to get serious. Want me to make a study plan that covers everything before exam day?`;
    }
  }

  return null;
}

export function adjustForExamProximity(
  daysToExam: number
): { intensityMultiplier: number; focusOnPastQuestions: boolean; shorterExplanations: boolean } {
  if (daysToExam <= 1) {
    return { intensityMultiplier: 1.5, focusOnPastQuestions: true, shorterExplanations: true };
  }
  if (daysToExam <= 7) {
    return { intensityMultiplier: 1.3, focusOnPastQuestions: true, shorterExplanations: false };
  }
  if (daysToExam <= 30) {
    return { intensityMultiplier: 1.1, focusOnPastQuestions: false, shorterExplanations: false };
  }
  return { intensityMultiplier: 1.0, focusOnPastQuestions: false, shorterExplanations: false };
}