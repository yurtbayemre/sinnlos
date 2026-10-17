"use server";

import { transitionItem, type AuthoringActionResult } from "./authoring-action";
import { saveItem, type SaveInput } from "./save";
import { buildCoursePayload, buildLessonPayload } from "./training-payload";
import { coerceCourseValues, coerceLessonValues } from "./training-values";

export async function saveCourse(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("courses", input, { coerce: coerceCourseValues, build: buildCoursePayload });
}
export async function saveLesson(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("lessons", input, { coerce: coerceLessonValues, build: buildLessonPayload });
}
export async function publishCourse(id: unknown, version: unknown): Promise<AuthoringActionResult> {
  return transitionItem("courses", "publish", id, version);
}
export async function unpublishCourse(
  id: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("courses", "unpublish", id, version);
}
export async function discardCourse(id: unknown, version: unknown): Promise<AuthoringActionResult> {
  return transitionItem("courses", "discardDraft", id, version);
}
export async function publishLesson(id: unknown, version: unknown): Promise<AuthoringActionResult> {
  return transitionItem("lessons", "publish", id, version);
}
export async function unpublishLesson(
  id: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("lessons", "unpublish", id, version);
}
export async function discardLesson(id: unknown, version: unknown): Promise<AuthoringActionResult> {
  return transitionItem("lessons", "discardDraft", id, version);
}
