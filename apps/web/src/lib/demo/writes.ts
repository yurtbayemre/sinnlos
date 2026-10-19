/**
 * The member writes of the demo: each answers like the cms (the created or
 * changed row in `{ data }`, its refusal as a StrapiError with the cms's
 * message) and changes the demo data set, so the page the action refreshes
 * shows the result.
 */
import {
  isCommentTargetType,
  isPollClosed,
  isQuizSelectionList,
  quizAnswersPass,
  type QuizCheckResponse,
} from "@sinnlos/domain";
import type { Classified, EmojiType, KudosValue, RsvpStatus } from "@/lib/types";
import type { DemoData, DemoHandler } from "./data";
import { DEMO_USER_ID } from "./people";
import { pollByRef } from "./polls";
import { cmsError, isRecord } from "./query";

const now = () => new Date().toISOString();
const nextId = (rows: readonly { id: number }[]) => Math.max(0, ...rows.map((row) => row.id)) + 1;
const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** The `data` object of a content-type write (`{ data: {...} }`). */
function payload(body: unknown): Record<string, unknown> {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data)) throw cmsError(400, 'Missing "data" payload in the request body');
  return data;
}

/**
 * The comment or reaction target the payload names: an existing
 * announcement or wiki page. Like the cms, a missing and an unknown target
 * get the same refusal (no existence oracle).
 */
function target(data: DemoData, input: Record<string, unknown>) {
  const { targetType, targetDocumentId } = input;
  if (!isCommentTargetType(targetType)) throw cmsError(400, "Invalid targetType");
  const rows = targetType === "announcement" ? data.announcements : data.wikiPages;
  if (!rows.some((row) => row.documentId != null && row.documentId === targetDocumentId)) {
    throw cmsError(400, "targetDocumentId required");
  }
  return { targetType, targetDocumentId: String(targetDocumentId) };
}

export const sendKudos: DemoHandler = ({ data, body }) => {
  const { to, message, value } = payload(body);
  const recipient = data.directory.find((user) => user.id === to);
  const note = text(message);
  if (!recipient || recipient.id === DEMO_USER_ID || !note || typeof value !== "string") {
    throw cmsError(400, "Invalid kudos");
  }
  const row = {
    id: nextId(data.kudosEntries),
    message: note,
    value: value as KudosValue,
    from: data.users.ada,
    to: recipient,
    createdAt: now(),
  };
  data.kudosEntries.unshift(row);
  return { data: row };
};

export const rsvp: DemoHandler = ({ data, body }) => {
  const { targetDocumentId, status } = payload(body);
  const event = data.events.find((e) => e.documentId === targetDocumentId);
  if (!event?.rsvpEnabled) throw cmsError(400, "Event not available for RSVP");
  if (status !== "yes" && status !== "maybe" && status !== "no") {
    throw cmsError(400, "Invalid status");
  }
  const rows = data.eventRsvps.filter((row) => row.targetDocumentId === event.documentId);
  const mine = rows.find((row) => row.user?.id === DEMO_USER_ID);
  const othersYes = rows.filter((row) => row !== mine && row.status === "yes").length;
  if (status === "yes" && event.capacity != null && othersYes >= event.capacity) {
    throw cmsError(400, "Event is at capacity");
  }
  const row = mine ?? {
    id: nextId(data.eventRsvps),
    targetDocumentId: event.documentId,
    status: status as RsvpStatus,
    user: data.users.ada,
  };
  Object.assign(row, { status, respondedAt: now() });
  if (!mine) data.eventRsvps.push(row);
  return { data: row };
};

export const addComment: DemoHandler = ({ data, body }) => {
  const input = payload(body);
  const note = text(input.body);
  if (!note) throw cmsError(400, "Comment body required");
  const row = {
    id: nextId(data.comments),
    body: note,
    ...target(data, input),
    author: data.users.ada,
    createdAt: now(),
  };
  data.comments.push(row);
  return { data: row };
};

/** The demo user is a member: only their own comments. */
export const deleteComment: DemoHandler = ({ data, match }) => {
  const index = data.comments.findIndex((row) => String(row.id) === match[1]);
  if (index < 0) throw cmsError(404, "Not Found");
  if (data.comments[index]!.author?.id !== DEMO_USER_ID) throw cmsError(403, "Forbidden");
  return { data: data.comments.splice(index, 1)[0] };
};

/** The desired end state (FX28), not a toggle. */
export const setReaction: DemoHandler = ({ data, body }) => {
  const input = payload(body);
  const { targetType, targetDocumentId } = target(data, input);
  if (typeof input.emoji !== "string") throw cmsError(400, "Invalid emoji");
  const emoji = input.emoji as EmojiType;
  const index = data.reactions.findIndex(
    (row) =>
      row.author?.id === DEMO_USER_ID &&
      row.emoji === emoji &&
      row.targetType === targetType &&
      row.targetDocumentId === targetDocumentId,
  );
  if (input.reacted === true && index < 0) {
    const row = {
      id: nextId(data.reactions),
      emoji,
      targetType,
      targetDocumentId,
      author: data.users.ada,
    };
    data.reactions.push(row);
    return { data: row };
  }
  if (input.reacted !== true && index >= 0) data.reactions.splice(index, 1);
  return { data: null };
};

/** The cms's checks in its order (poll-vote.ts); one ballot per voter. */
export const vote: DemoHandler = ({ data, body, match }) => {
  const poll = pollByRef(data, decodeURIComponent(match[1]!));
  const tally = poll?.documentId ? data.pollTallies[poll.documentId] : undefined;
  if (!poll || !tally) throw cmsError(404, "Not Found");
  if (!tally.canVote) throw cmsError(403, "Not in poll audience");
  const { optionIndex, option } = isRecord(body) ? body : {};
  if (
    typeof optionIndex !== "number" ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= poll.options.length
  ) {
    throw cmsError(400, "Invalid optionIndex");
  }
  if (option !== undefined && option !== poll.options[optionIndex]) {
    throw cmsError(400, "Poll options changed");
  }
  if (isPollClosed(poll.closesAt)) throw cmsError(400, "Poll is closed");
  if (tally.myVoteIndex != null) throw cmsError(400, "Already voted");
  tally.counts[optionIndex] = (tally.counts[optionIndex] ?? 0) + 1;
  tally.total += 1;
  tally.myVoteIndex = optionIndex;
  return { data: { id: tally.total, optionIndex } };
};

/** The cms's checks in its order (acknowledgement.ts); one receipt per announcement. */
export const acknowledge: DemoHandler = ({ data, body }) => {
  const { targetType, targetDocumentId } = payload(body);
  if (targetType !== "announcement") throw cmsError(400, "Invalid targetType");
  if (!text(targetDocumentId)) throw cmsError(400, "targetDocumentId required");
  const announcement = data.announcements.find(
    (a) => a.documentId === targetDocumentId && a.requiresAck,
  );
  if (!announcement) throw cmsError(400, "Target not available for acknowledgement");
  if (data.acknowledgements.some((row) => row.targetDocumentId === announcement.documentId)) {
    throw cmsError(400, "Already acknowledged");
  }
  const row = {
    id: nextId(data.acknowledgements),
    targetType: "announcement" as const,
    targetDocumentId: announcement.documentId,
    acknowledgedAt: now(),
    user: data.users.ada,
  };
  data.acknowledgements.push(row);
  return { data: row };
};

function markRead(rows: { readAt?: string | null }[]) {
  const stamp = now();
  for (const row of rows) row.readAt = stamp;
  return { data: { count: rows.length } };
}

export const markNotificationsRead: DemoHandler = ({ data, body }) => {
  const ids = isRecord(body) && Array.isArray(body.ids) ? body.ids : null;
  if (!ids) throw cmsError(400, "ids required");
  return markRead(data.notifications.filter((row) => ids.includes(row.id) && !row.readAt));
};

export const markAllNotificationsRead: DemoHandler = ({ data }) =>
  markRead(data.notifications.filter((row) => !row.readAt));

/** The profile fields the self-service PUT /api/me takes (FX02). */
const PROFILE_FIELDS = [
  "displayName",
  "jobTitle",
  "phone",
  "officeLocation",
  "birthday",
  "birthdayVisible",
  "digestAnnouncements",
  "digestMentions",
  "digestKudos",
  "digestFrequency",
];
const PERSON_FIELDS = ["displayName", "jobTitle", "phone", "officeLocation"];

export const updateMe: DemoHandler = ({ data, body }) => {
  const input = payload(body);
  const pick = (fields: string[]) =>
    Object.fromEntries(fields.filter((key) => key in input).map((key) => [key, input[key]]));
  Object.assign(data.me, pick(PROFILE_FIELDS));
  // The name and the title show wherever the demo user appears.
  const person = pick(PERSON_FIELDS);
  Object.assign(data.users.ada, person);
  const listed = data.directory.find((user) => user.id === DEMO_USER_ID);
  if (listed) Object.assign(listed, person);
  return { data: data.me };
};

/** The cms's order (lesson-progress.ts): target, quiz grade, one receipt per lesson. */
export const completeLesson: DemoHandler = ({ data, body }) => {
  const { targetDocumentId, answers } = payload(body);
  const lesson = data.lessonRows.find((row) => row.documentId === targetDocumentId);
  if (!lesson?.documentId) throw cmsError(400, "Target not available for completion");
  if (!quizAnswersPass(data.quizzes[lesson.documentId] ?? [], answers)) {
    throw cmsError(400, "Quiz not passed");
  }
  if (data.lessonProgress.some((row) => row.targetDocumentId === lesson.documentId)) {
    throw cmsError(400, "Already completed");
  }
  const row = {
    id: nextId(data.lessonProgress),
    targetDocumentId: lesson.documentId,
    completedAt: now(),
    user: data.users.ada,
  };
  data.lessonProgress.push(row);
  return { data: row };
};

/** Feedback only, like the cms's checkStoredQuiz: no receipt; an exam answers no verdicts. */
export const checkLesson: DemoHandler = ({ data, body, match }) => {
  const lesson = data.lessonRows.find((row) => row.documentId === decodeURIComponent(match[1]!));
  if (!lesson?.documentId) throw cmsError(404, "Not Found");
  const quiz = data.quizzes[lesson.documentId] ?? [];
  const completionMode = lesson.course?.completionMode ?? "confirm";
  const selections = isRecord(body) && isRecord(body.data) ? body.data.answers : undefined;
  if (
    !isQuizSelectionList(selections) ||
    selections.length > quiz.length ||
    (completionMode !== "confirm" && selections.length !== quiz.length) ||
    selections.some((s) => s.optionIndex >= (quiz[s.questionIndex]?.options.length ?? 0))
  ) {
    throw cmsError(400, "Invalid quiz answers");
  }
  const answers: (number | undefined)[] = Array(quiz.length).fill(undefined);
  for (const { questionIndex, optionIndex } of selections) answers[questionIndex] = optionIndex;
  const result: QuizCheckResponse["data"] = {
    completionMode,
    passed: quizAnswersPass(quiz, answers),
  };
  if (completionMode !== "exam") {
    result.verdicts = selections.map(({ questionIndex, optionIndex }) => ({
      questionIndex,
      correct: optionIndex === quiz[questionIndex]!.correctIndex,
    }));
  }
  return { data: result };
};

/** The fields an ad's author sets; images need the upload, which the demo skips. */
const AD_SERVER_FIELDS = new Set(["id", "documentId", "author", "images"]);
function adFields(input: Record<string, unknown>): Partial<Classified> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !AD_SERVER_FIELDS.has(key)),
  ) as Partial<Classified>;
}

export const createAd: DemoHandler = ({ data, body }) => {
  const fields = adFields(payload(body));
  const title = text(fields.title);
  if (!title) throw cmsError(400, "Invalid title");
  const id = nextId(data.classifieds);
  const row: Classified = {
    ...fields,
    id,
    documentId: `demoad${String(id).padStart(18, "0")}`,
    title,
    images: null,
    author: data.users.ada,
    createdAt: now(),
  };
  data.classifieds.unshift(row);
  return { data: row };
};

/** The demo user is a member: only their own ads. */
function ownAd(data: DemoData, id: string | undefined): Classified {
  const ad = data.classifieds.find((row) => String(row.id) === id);
  if (!ad) throw cmsError(404, "Not Found");
  if (ad.author?.id !== DEMO_USER_ID) throw cmsError(403, "Forbidden");
  return ad;
}

export const updateAd: DemoHandler = ({ data, body, match }) => {
  const ad = ownAd(data, match[1]);
  Object.assign(ad, adFields(payload(body)));
  return { data: ad };
};

export const deleteAd: DemoHandler = ({ data, match }) => {
  const ad = ownAd(data, match[1]);
  data.classifieds.splice(data.classifieds.indexOf(ad), 1);
  return { data: ad };
};

/** Search telemetry: accepted and dropped (the demo's summary is fixed). */
export const logSearch: DemoHandler = () => ({ data: null });
