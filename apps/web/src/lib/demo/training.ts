import type { QuizQuestion } from "@sinnlos/domain";
import type { Course, Lesson, LessonProgress } from "@/lib/types";
import type { DemoClock } from "./clock";

export function demoTraining(clock: DemoClock) {
  // With the answer key, like the cms stores it: the player leaves it out,
  // the check and the completion grade with it.
  const quizzes: Record<string, QuizQuestion[]> = {
    demolesson00000000000001: [
      {
        question: "A mail urges you to pay an invoice within 30 minutes. What do you do?",
        options: [
          "Pay it — sounds urgent",
          "Verify via a known contact on a second channel",
          "Forward it to a colleague",
        ],
        correctIndex: 1,
      },
    ],
  };

  const lessons = [
    {
      id: 1,
      documentId: "demolesson00000000000001",
      title: "Why security awareness matters",
      order: 1,
      body: '# Why this matters\n\nPhishing is the #1 entry vector. This 5-minute lesson shows the three patterns to watch for:\n\n1. **Urgency** ("act now!")\n2. **Authority** ("the CEO needs...")\n3. **Unusual channels**\n\n> When in doubt: verify via a second channel.',
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
    {
      id: 2,
      documentId: "demolesson00000000000002",
      title: "Passwords & 2FA",
      order: 2,
      body: "## Rules of thumb\n\n- Use the password manager for **everything**\n- One account, one password\n- 2FA on for mail, VPN and admin tools",
    },
    {
      id: 3,
      documentId: "demolesson00000000000003",
      title: "Reporting an incident",
      order: 3,
      body: "If something feels off: **report early**. There is no penalty for false alarms — there is for silence.",
    },
  ] satisfies Lesson[];

  const courses = [
    {
      id: 1,
      documentId: "democourse00000000000001",
      title: "Security awareness basics",
      slug: "security-awareness-basics",
      completionMode: "quizGate",
      description: "Mandatory annual security training: phishing, passwords, incident reporting.",
      mandatory: true,
      validityMonths: 12,
      lessons: lessons,
      updatedAt: clock.iso(-4),
    },
    {
      id: 2,
      documentId: "democourse00000000000002",
      title: "Working with the intranet",
      slug: "working-with-the-intranet",
      description: "Optional tour: wiki, announcements, events and the marketplace.",
      mandatory: false,
      lessons: [
        {
          id: 10,
          documentId: "demolesson00000000000010",
          title: "Finding things (search & wiki)",
          order: 1,
          body: "Press **Ctrl+K** anywhere.",
        },
      ],
      updatedAt: clock.iso(-10),
    },
  ] satisfies Course[];

  /** Every lesson with its course (the /api/lessons rows). */
  const lessonRows: Lesson[] = courses.flatMap((c) =>
    c.lessons.map((l) => ({
      ...l,
      course: {
        id: c.id,
        documentId: c.documentId,
        title: c.title,
        slug: c.slug,
        completionMode: c.completionMode ?? "confirm",
      },
    })),
  );

  // Done last year: the annual course is due again within 30 days (renewal, v0.20).
  const lessonProgress: LessonProgress[] = lessons.map((lesson, i) => ({
    id: i + 1,
    targetDocumentId: lesson.documentId,
    completedAt: clock.iso(-350),
  }));

  return { quizzes, courses, lessonRows, lessonProgress };
}
