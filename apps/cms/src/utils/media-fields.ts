import { DOCUMENT_FILE_MIME_TYPES, IMAGE_FORMATS, UPLOAD_FORMAT_SPECS } from "@sinnlos/domain";

const IMAGE_MIMES = IMAGE_FORMATS.map((format) => UPLOAD_FORMAT_SPECS[format].mime);

/** The same field MIME rules for early authoring checks and locked media claims. */
export const MEDIA_CLAIM_FIELDS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  "api::document.document": { file: DOCUMENT_FILE_MIME_TYPES },
  "api::course.course": { coverImage: IMAGE_MIMES },
  "api::department.department": { headerImage: IMAGE_MIMES },
  "api::team.team": { avatar: IMAGE_MIMES },
};
