import type { Route } from "next";

export const coursePath = (course: string): Route =>
  `/manage/training/${encodeURIComponent(course)}` as Route;
export const lessonListPath = (course: string): Route => `${coursePath(course)}/lessons` as Route;
export const lessonPath = (course: string, lesson: string): Route =>
  `${lessonListPath(course)}/${encodeURIComponent(lesson)}` as Route;
export const newLessonPath = (course: string): Route => `${lessonListPath(course)}/new` as Route;
