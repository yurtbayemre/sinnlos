/**
 * Values of `json` attributes as the Strapi admin panel sends them.
 *
 * Strapi 5.55.1's admin JSON input (@strapi/admin
 * dist/admin/admin/src/components/FormInputs/Json.mjs) stores the raw editor
 * text in the form as soon as an author types in it, and '' when a field
 * that is not required is cleared. The Content Manager submits the whole
 * form without parsing it (content-manager DocumentActions.mjs transformData),
 * and neither the core validators (`json` is yup.mixed()) nor the document
 * service JSON.parse it. A lifecycle hook on such a field therefore sees:
 *   - the parsed value (array, object, number, boolean, null) when the field
 *     was not touched: the form still holds what the API returned;
 *   - a string when it was edited;
 *   - '' when it was cleared.
 * Content-API writers (the web app, scripts) send parsed JSON.
 *
 * parseAdminJsonField turns all of these into the parsed value, so a
 * lifecycle can validate one shape and write the result back into
 * `event.params.data`. Pure; no Strapi runtime.
 */

export type AdminJsonResult = { ok: true; value: unknown } | { ok: false };

/**
 * - a non-string value: returned unchanged;
 * - an empty or whitespace-only string: null (the author cleared the field);
 * - any other string: JSON.parse'd, or `{ ok: false }` when it is not JSON.
 */
export function parseAdminJsonField(value: unknown): AdminJsonResult {
  if (typeof value !== "string") return { ok: true, value };
  if (value.trim() === "") return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}
